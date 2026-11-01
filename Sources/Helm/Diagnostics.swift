// Self test: prints counts and timings only, never terminal text or page content, so it is safe to run against a live
// Herdr session.
import SwiftUI
import HelmCore
import HelmTerminal
import SwiftTerm

@MainActor
enum SelfTest {
    static func run(after secs: Double, model: AppModel) async {
        try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
        let s = model.snapshot
        var counts: [String: Int] = [:]
        for a in s.agents { counts[a.state.rawValue, default: 0] += 1 }
        print("link=\(model.store.link) verdict=\(model.streamVerdict) renderer=\(model.renderer.rawValue) writes=\(model.writesEnabled)")
        print("spaces=\(s.workspaces.count) tabs=\(s.tabs.count) agents=\(s.agents.count) states=\(counts.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ","))")
        if let w = Capture.mainWindow() { print("window=\(Int(w.frame.width))x\(Int(w.frame.height))") }
        if model.fallback.running || model.fallback.exitCode != nil {
            let rows = model.fallback.view.visibleRowsText(0..<6).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            print("fallback: running=\(model.fallback.running) exit=\(model.fallback.exitCode.map(String.init) ?? "-") rows=\(rows)")
        }
        if let h = model.held { print("compose: held=\(h.phase) to=\(h.agentName) pane=\(h.paneID) boxNow=\(model.compose.isEmpty ? "empty" : "kept")") } else { print("compose: nothing held") }
        print("snapshot=\(model.store.snapshotBytes) bytes in \(String(format: "%.1f", model.store.snapshotMillis)) ms, events=\(model.store.eventCount), waiting=\(model.waiting.count), reconnects=\(model.store.reconnectCount)")
        if let e = model.primary.engine as? SwiftTermEngine {
            func hex(_ c: NSColor) -> String { let s = c.usingColorSpace(.sRGB) ?? c; return String(format: "%02x%02x%02x", Int(s.redComponent * 255), Int(s.greenComponent * 255), Int(s.blueComponent * 255)) }
            print("swiftterm colours: theme.bg=\(hex(e.view.theme.bg)) nativeBg=\(hex(e.view.nativeBackgroundColor)) nativeFg=\(hex(e.view.nativeForegroundColor)) dark=\(model.themeIsDark) frame=\(e.view.frame) font=\(e.view.fontPoints)")
        }
        if let e = model.primary.engine as? SwiftTermEngine {
            func hex(_ c: NSColor) -> String { let s = c.usingColorSpace(.sRGB) ?? c; return String(format: "%02x%02x%02x", Int(s.redComponent * 255), Int(s.greenComponent * 255), Int(s.blueComponent * 255)) }
            print("swiftterm: theme.bg=\(hex(e.view.theme.bg)) nativeBg=\(hex(e.view.nativeBackgroundColor)) dark=\(model.themeIsDark) frame=\(e.view.frame) font=\(e.view.fontPoints) dims=\(e.view.terminalDimensions.cols)x\(e.view.terminalDimensions.rows)")
        }
        for (label, sess) in [("primary", model.primary), ("compare", model.secondary)] where sess.paneID != nil {
            let st = sess.stats
            var nonBlank = 0
            for r in 0..<sess.engine.rows where !sess.engine.rowText(r).isEmpty { nonBlank += 1 }
            print("\(label): state=\(sess.state) engine=\(sess.engine.name) grid=\(sess.engine.cols)x\(sess.engine.rows) nonBlankRows=\(nonBlank) frames=\(st.frames) full=\(st.fullFrames) bytes=\(st.bytes) seqGaps=\(st.seqGaps) reconnects=\(st.reconnects) unhandled=\(sess.engine.unhandledSequenceCount) applyMaxMs=\(String(format: "%.2f", Double(st.applyNanosMax) / 1e6))")
        }
        for box in model.web.allBoxes {
            let probe: String = await withCheckedContinuation { c in box.probe { c.resume(returning: $0) } }
            print("web \(box.kind.rawValue): phase=\(box.phase) loadSeconds=\(box.loadSeconds.map { String(format: "%.2f", $0) } ?? "n/a") pid=\(box.pid ?? -1) probe=\(probe)")
        }
        model.updateStats()
        print("stats: \(model.statsLine)")
        model.shutdown()
        NSApplication.shared.terminate(nil)
    }
}
