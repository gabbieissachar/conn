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

/// Drives the real editor the way a user would: opens a file, types into the NSTextView, saves through the model.
@MainActor
enum EditorSelfTest {
    static func findTextView(in v: NSView) -> NSTextView? {
        if let t = v as? NSTextView, t.isEditable { return t }
        for s in v.subviews { if let t = findTextView(in: s) { return t } }
        return nil
    }

    static func run(file: String, model: AppModel) async {
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        let before = (try? String(contentsOfFile: file, encoding: .utf8)) ?? "<unreadable>"
        await wait(2)
        model.mode = .editor
        model.editor.open(URL(fileURLWithPath: file))
        await wait(1.5)
        guard let doc = model.editor.current, let root = Capture.mainWindow()?.contentView, let tv = findTextView(in: root) else {
            print("editor-test: no editor text view found"); return
        }
        print("editor-test: opened \(doc.title) chars=\(doc.text.count) dirty=\(doc.isDirty)")
        tv.setSelectedRange(NSRange(location: 0, length: 0))
        tv.insertText("TYPED-BY-TEST ", replacementRange: NSRange(location: 0, length: 0))
        await wait(0.3)
        print("editor-test: after typing dirty=\(doc.isDirty) modelStartsWithTyped=\(doc.text.hasPrefix("TYPED-BY-TEST "))")
        model.editor.save(doc)
        let after = (try? String(contentsOfFile: file, encoding: .utf8)) ?? "<unreadable>"
        print("editor-test: saved dirty=\(doc.isDirty) diskStartsWithTyped=\(after.hasPrefix("TYPED-BY-TEST ")) diskGrewBy=\(after.count - before.count)")
    }
}

/// Measures how long after a pane's first frame SwiftTerm actually draws, from its own draw hook.
/// If the display is asleep AppKit and the display link may never draw: the probe says so rather than guessing.
@MainActor
enum DrawProbe {
    static func run(model: AppModel) async {
        guard model.primary.engine is SwiftTermEngine else { print("draw-probe: primary is not SwiftTerm"); return }
        let t0 = monotonicNanos()
        var firstFrame: UInt64?
        for _ in 0..<300 {
            try? await Task.sleep(nanoseconds: 20_000_000)
            if firstFrame == nil, model.primary.stats.frames > 0 { firstFrame = monotonicNanos() }
        }
        let all = DrawLog.shared.snapshot
        let after = firstFrame.flatMap { f in all.first { $0 >= f } }
        let engine = model.primary.engine as! SwiftTermEngine
        func ms(_ t: UInt64?, from: UInt64?) -> String { guard let t = t, let f = from else { return "never" }; return String(format: "%.0f ms", Double(t - f) / 1e6) }
        // Render the view's layer the way Core Animation would present it, and count what is on it.
        if let layer = engine.view.layer {
            let w = Int(layer.bounds.width * 2), h = Int(layer.bounds.height * 2)
            if w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                // Over the theme background, as the view's own layer colour sits behind its contents.
                ctx.setFillColor(model.terminalTheme.bg.cgColor); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
                ctx.scaleBy(x: 2, y: 2)
                layer.render(in: ctx)
                let px = ctx.data!.assumingMemoryBound(to: UInt8.self)
                var colours = Set<UInt32>(); var nonUniform = 0
                let first = (UInt32(px[0]) << 24) | (UInt32(px[1]) << 16) | (UInt32(px[2]) << 8) | UInt32(px[3])
                var i = 0
                while i < w * h * 4 { let c = (UInt32(px[i]) << 24) | (UInt32(px[i + 1]) << 16) | (UInt32(px[i + 2]) << 8) | UInt32(px[i + 3]); colours.insert(c); if c != first { nonUniform += 1 }; i += 4 * 7 }
                if let path = ProcessInfo.processInfo.environment["HELM_LAYER_PNG"], let cg = ctx.makeImage() {
                    Capture.writePNG(NSBitmapImageRep(cgImage: cg), to: URL(fileURLWithPath: path))
                }
                print(String(format: "layer-render: %dx%d corner=%08x distinctColours=%d pixelsDifferentFromCorner=%d (sampled)", w, h, first, colours.count, nonUniform))
            }
        }
        print("draw-probe: frameAt=\(String(format: "%.2f", Double((firstFrame ?? t0) - t0) / 1e9))s draws=\(all.count) firstDrawAfterFirstFrame=\(ms(after, from: firstFrame)) nudges=\(engine.displayNudges)")
    }
}
