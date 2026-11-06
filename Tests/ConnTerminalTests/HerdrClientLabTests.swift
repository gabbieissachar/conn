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
    static var session: String? {
        guard let s = ProcessInfo.processInfo.environment["CONN_HERDR_LAB_SESSION"],
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
