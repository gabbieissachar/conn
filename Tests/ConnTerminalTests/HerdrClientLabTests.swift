import Testing
import Foundation
import AppKit
import ConnCore
@testable import ConnTerminal

/// The one lab-only end-to-end check of the Herdr client mode: attach, client-local workspace switching, stop.
///
/// It is skipped unless `CONN_HERDR_LAB_SESSION` names a throwaway Herdr session, and it refuses any name that is not
/// `fm-lab-...`: it must never reach a person's own session (`esim`, `default`, ...). The session must already hold two
/// workspaces, "Lab Alpha" and "Lab Beta", each with one pane running a loop that prints `ALPHA tick N` / `BETA tick N`
/// (`herdr --session S workspace create --label "Lab Alpha"`, then `pane run` in its pane). Run it with
/// `CONN_HERDR_LAB_SESSION=fm-lab-... ./test.sh --filter HerdrClientLabTests`. It runs headless: the terminal views are never
/// put in a window, and it attaches only to the named session.
enum HerdrLab {
    static var requested: Bool { ProcessInfo.processInfo.environment["CONN_HERDR_LAB_SESSION"] != nil }
    static var session: String? { name(in: "CONN_HERDR_LAB_SESSION") }
    /// The sidebar navigation check has its own lab session (see HerdrClientSidebarLabTests for what it must hold).
    static var navRequested: Bool { ProcessInfo.processInfo.environment["CONN_HERDR_LAB_NAV_SESSION"] != nil }
    static var navSession: String? { name(in: "CONN_HERDR_LAB_NAV_SESSION") }
    private static func name(in variable: String) -> String? {
        guard let s = ProcessInfo.processInfo.environment[variable],
              s.range(of: "^fm-lab-[A-Za-z0-9][A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return nil }
        return s
    }
}

extension SwiftTermMainActorTests {
@Suite("Herdr client mode, lab end to end", .enabled(if: HerdrLab.requested)) @MainActor struct HerdrClientLabTests {
    func screen(_ c: FallbackTerminalController) -> String {
        c.view.visibleRowsText(0..<c.view.terminalDimensions.rows).joined(separator: "\n")
    }

    func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return condition()
    }

    func type(_ c: FallbackTerminalController, _ keys: [UInt8]...) async {
        for k in keys { c.view.send(k); try? await Task.sleep(nanoseconds: 250_000_000) }
    }

    @Test func attachHidesTheSidebarKeysStayInTheClientAndStopEndsOnlyThatClient() async throws {
        let lab = try #require(HerdrLab.session, "CONN_HERDR_LAB_SESSION must name a session called fm-lab-...")
        let fm = FileManager.default
        let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-lab-\(UUID().uuidString)")
        let home = scratch.appendingPathComponent("home").path, temp = scratch.appendingPathComponent("tmp").path
        try fm.createDirectory(atPath: temp, withIntermediateDirectories: true)

        // A stand-in for the person's own Herdr config, so the check does not depend on this machine's: it has a prefix key
        // other than Herdr's default, a workspace picker key, the first-run onboarding already done and the sidebar showing.
        let source = URL(fileURLWithPath: temp).appendingPathComponent("source.toml")
        try "onboarding = false\n\n[keys]\nprefix = \"ctrl+a\"\nworkspace_picker = \"prefix+w\"\n\n[ui]\nsidebar_start_collapsed = false\n".write(to: source, atomically: true, encoding: .utf8)
        let hiddenConfig = try #require(try HerdrClientConfig.resolve(hideSidebar: true, custom: nil, home: home, temporaryDirectory: temp, sourceConfig: source))
        let shownConfig = try HerdrClientConfig.validate(source.path, home: home, temporaryDirectory: temp)

        let endpoint = HerdrEndpoint(session: lab)
        try #require(endpoint.binaryPath != nil, "no herdr executable found")

        // Herdr itself accepts the generated file.
        let check = Process()
        check.executableURL = URL(fileURLWithPath: endpoint.binaryPath!)
        check.arguments = ["config", "check"]
        check.environment = FallbackTerminalController.environment(base: ProcessInfo.processInfo.environment, endpoint: endpoint, clientConfig: hiddenConfig)
        let out = Pipe(); check.standardOutput = out; check.standardError = out
        try check.run(); check.waitUntilExit()
        #expect(check.terminationStatus == 0, "herdr config check: \(String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")")

        // Client A: Conn's Herdr client mode, sidebar hidden. Client B: another client with the sidebar showing.
        let a = FallbackTerminalController(), b = FallbackTerminalController()
        for c in [a, b] { c.view.frame = NSRect(x: 0, y: 0, width: 1100, height: 640) }
        a.start(endpoint: endpoint, theme: .dark, clientConfig: hiddenConfig)
        b.start(endpoint: endpoint, theme: .dark, clientConfig: shownConfig)
        defer { a.stop(); b.stop() }
        #expect(a.running && b.running)
        #expect(a.view.terminalDimensions.cols >= 80, "the client pty is too narrow for Herdr's desktop layout")

        let started = await wait(15) { (screen(a).contains("ALPHA tick") || screen(a).contains("BETA tick")) && screen(b).contains("Lab Beta") }
        #expect(started, "clients did not draw.\nA:\n\(screen(a))\nB:\n\(screen(b))")

        // Attach: A shows Herdr's tab row and panes, no sidebar; B shows the sidebar with both workspaces.
        let sidebarWords = ["Lab Alpha", "Lab Beta"]
        #expect(sidebarWords.allSatisfy { !screen(a).contains($0) }, "A still shows Herdr's sidebar:\n\(screen(a))")
        #expect(sidebarWords.allSatisfy { screen(b).contains($0) }, "B has no sidebar:\n\(screen(b))")
        let firstIsAlpha = screen(a).contains("ALPHA tick")
        let here = firstIsAlpha ? "ALPHA tick" : "BETA tick", there = firstIsAlpha ? "BETA tick" : "ALPHA tick"
        #expect(screen(b).contains(here) && !screen(b).contains(there), "A and B did not start on the same workspace:\n\(screen(b))")

        // Client-local switch: Ctrl+A (the stand-in config's prefix, so the generated file kept it), w (workspace navigation),
        // an arrow toward the other workspace, Return. The bytes go to A's pty, as typing in the pane does.
        let ctrlA: [UInt8] = [0x01], w: [UInt8] = Array("w".utf8), enter: [UInt8] = [0x0d]
        let arrow: [UInt8] = firstIsAlpha ? [0x1b, 0x5b, 0x42] : [0x1b, 0x5b, 0x41]   // down toward Beta, up toward Alpha
        await type(a, ctrlA, w, arrow, enter)
        let switched = await wait(8) { screen(a).contains(there) && !screen(a).contains(here) }
        #expect(switched, "A did not switch workspace.\nA:\n\(screen(a))")
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(screen(b).contains(here) && !screen(b).contains(there), "B moved with A:\n\(screen(b))")

        // Stop ends A only.
        a.stop()
        let stopped = await wait(8) { !a.running }
        #expect(stopped, "A did not stop")
        #expect(b.running && screen(b).contains(here), "B was affected by stopping A:\n\(screen(b))")
        b.stop()
        #expect(await wait(8) { !b.running })
    }
}
}

/// The lab-only end-to-end check of sidebar navigation: two attached clients, and a sidebar-driven switch of workspace and of
/// tab that must move only the embedded one.
///
/// Skipped unless `CONN_HERDR_LAB_NAV_SESSION` names a throwaway session (`fm-lab-...`; any other name is refused). The session
/// must already hold at least 11 workspaces, and a workspace with at least 11 tabs, so the keys past 9 are exercised. Every
/// pane runs a loop that prints `<workspace label>-T<tab number> tick N`: workspaces labelled `NAV01`, `NAV02`, ... and tabs
/// numbered from 1 (`NAV03-T7 tick 12`). Run it with
/// `CONN_HERDR_LAB_NAV_SESSION=fm-lab-... ./test.sh --filter HerdrClientSidebarLabTests`. Headless: the terminal views are
/// never in a window, and it attaches only to the named session.
extension SwiftTermMainActorTests {
@Suite("Herdr client sidebar navigation, lab end to end", .enabled(if: HerdrLab.navRequested)) @MainActor struct HerdrClientSidebarLabTests {
    func screen(_ c: FallbackTerminalController) -> String {
        c.view.visibleRowsText(0..<c.view.terminalDimensions.rows).joined(separator: "\n")
    }

    func wait(_ seconds: Double, until condition: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return condition()
    }

    /// The `<label>-T<n>` a pane's loop is printing on this client's screen, or nil.
    func shown(_ c: FallbackTerminalController) -> String? {
        let text = screen(c)
        guard let r = text.range(of: "NAV[0-9]+-T[0-9]+ tick", options: [.regularExpression, .backwards]) else { return nil }
        return String(text[r]).replacingOccurrences(of: " tick", with: "")
    }

    @Test func sidebarSwitchesMoveOnlyTheEmbeddedClient() async throws {
        let lab = try #require(HerdrLab.navSession, "CONN_HERDR_LAB_NAV_SESSION must name a session called fm-lab-...")
        let fm = FileManager.default
        let scratch = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("conn-lab-nav-\(UUID().uuidString)")
        let home = scratch.appendingPathComponent("home").path, temp = scratch.appendingPathComponent("tmp").path
        try fm.createDirectory(atPath: temp, withIntermediateDirectories: true)
        // A stand-in for the person's config with a prefix other than Herdr's default, so the key map must come from the file.
        let source = URL(fileURLWithPath: temp).appendingPathComponent("source.toml")
        try "onboarding = false\n\n[keys]\nprefix = \"ctrl+a\"\n\n[ui]\nsidebar_start_collapsed = false\n".write(to: source, atomically: true, encoding: .utf8)
        let hiddenConfig = try #require(try HerdrClientConfig.resolve(hideSidebar: true, custom: nil, home: home, temporaryDirectory: temp, sourceConfig: source))
        let shownConfig = try HerdrClientConfig.validate(source.path, home: home, temporaryDirectory: temp)
        let keymap = try HerdrClientKeymap.load(configPath: hiddenConfig)
        #expect(keymap.prefix == [0x01])

        let endpoint = HerdrEndpoint(session: lab)
        try #require(endpoint.binaryPath != nil, "no herdr executable found")
        let reader = HerdrClient(endpoint: endpoint)
        let before = try reader.snapshot()
        #expect(before.workspaces.count >= 11, "the lab needs 11 or more workspaces, to reach the keys past 9")
        let busiest = try #require(before.workspaces.max { before.tabs(in: $0.id).count < before.tabs(in: $1.id).count })
        #expect(before.tabs(in: busiest.id).count >= 11, "the lab needs a workspace with 11 or more tabs")

        // Client A is Conn's embedded client (sidebar hidden); client B is another screen on the same session.
        let a = FallbackTerminalController(), b = FallbackTerminalController()
        for c in [a, b] { c.view.frame = NSRect(x: 0, y: 0, width: 1100, height: 640) }
        a.start(endpoint: endpoint, theme: .dark, clientConfig: hiddenConfig)
        b.start(endpoint: endpoint, theme: .dark, clientConfig: shownConfig)
        defer { a.stop(); b.stop() }
        #expect(await wait(15) { shown(a) != nil && shown(b) != nil }, "clients did not draw.\nA:\n\(screen(a))\nB:\n\(screen(b))")
        let bStart = try #require(shown(b))
        #expect(shown(a) == bStart, "A and B did not start on the same tab")

        // The same wiring the app uses: keys into A's pty, and a fresh read of Herdr's focus pointer.
        let navigator = HerdrClientNavigator(
            send: { bytes in await MainActor.run { _ = a.sendNavigation(bytes) } },
            readFocus: { await Task.detached { (try? reader.snapshot()).map { HerdrClientNavigator.Focus(workspaceID: $0.focusedWorkspaceID, tabID: $0.focusedTabID) } }.value })
        func go(_ target: HerdrClientNavigation.Target, expecting prefix: String, _ what: String) async throws {
            let snap = try reader.snapshot()
            let stages = try HerdrClientNavigation.plan(to: target, in: snap, keymap: keymap)
            let outcome = await navigator.run(stages)
            #expect(outcome == .landed, "\(what): \(outcome)")
            #expect(await wait(8) { shown(a)?.hasPrefix(prefix) == true }, "\(what): A shows \(shown(a) ?? "nothing"), wanted \(prefix)*.\n\(screen(a))")
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            #expect(shown(b) == bStart, "\(what): B moved to \(shown(b) ?? "nothing")")
        }

        let workspaces = before.workspaces
        let second = workspaces[1], last = workspaces[workspaces.count - 1]
        try await go(.workspace(second.id), expecting: "\(second.label)-T", "workspace 2")
        try await go(.workspace(last.id), expecting: "\(last.label)-T", "last workspace (position \(workspaces.count), past 9)")
        try await go(.workspace(workspaces[0].id), expecting: "\(workspaces[0].label)-T", "workspace 1")

        let tabs = before.tabs(in: busiest.id).sorted { $0.number < $1.number }
        for t in [tabs[1], tabs[tabs.count - 1], tabs[0]] {
            try await go(.tab(t.id), expecting: "\(busiest.label)-T\(t.number)", "tab \(t.number) of \(busiest.label)")
        }
        #expect(shown(b) == bStart)

        // A key map that does not match the client's config does not move it, and the check says so instead of reporting a landing.
        let wrong = HerdrClientKeymap(prefix: [0x07], workspacePicker: keymap.workspacePicker, navigateDown: keymap.navigateDown, nextTab: keymap.nextTab)
        let aBefore = shown(a)
        let stages = try HerdrClientNavigation.plan(to: .workspace(second.id), in: try reader.snapshot(), keymap: wrong)
        let slow = HerdrClientNavigator(send: { bytes in await MainActor.run { _ = a.sendNavigation(bytes) } },
                                        readFocus: { await Task.detached { (try? reader.snapshot()).map { HerdrClientNavigator.Focus(workspaceID: $0.focusedWorkspaceID, tabID: $0.focusedTabID) } }.value })
        slow.confirmTimeout = 1.5
        let miss = await slow.run(stages)
        guard case .failed = miss else { Issue.record("a wrong prefix was reported as landed: \(miss)"); return }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        #expect(shown(a) == aBefore && shown(b) == bStart)
    }
}
}
