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
        tv.window?.makeFirstResponder(tv)
        let viaChain = TextFinderCommand.send(.showFindInterface)
        await wait(0.4)
        let visibleViaChain = tv.enclosingScrollView?.isFindBarVisible ?? false
        let viaDirect = TextFinderCommand.send(.showFindInterface, to: tv)
        await wait(0.4)
        print("editor-test: Find through the responder chain handled=\(viaChain) barVisible=\(visibleViaChain); sent straight to the text view handled=\(viaDirect) barVisible=\(tv.enclosingScrollView?.isFindBarVisible ?? false) windowIsKey=\(tv.window?.isKeyWindow ?? false)")
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

/// Drives the UI paths a user would: modes, compare, privacy, tabs, switcher, background pause. Prints one line per check.
@MainActor
enum UICheck {
    static func run(model: AppModel) async {
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func report(_ name: String, _ ok: Bool, _ detail: String = "") { print("ui-check: \(ok ? "PASS" : "FAIL") \(name) \(detail)") }
        await wait(4)
        if Runtime.config.runsInBackground {
            let wins = NSApp.windows.filter { $0.isVisible }
            report("test mode keeps the app out of the way (accessory, not active, no key window, windows invisible and click-through)",
                   NSApp.activationPolicy() == .accessory && !NSApp.isActive && !wins.contains { $0.isKeyWindow } && wins.allSatisfy { $0.alphaValue == 0 && $0.ignoresMouseEvents },
                   "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) windows=\(wins.count) keyWindows=\(wins.filter { $0.isKeyWindow }.count) alpha=\(wins.map { $0.alphaValue })")
        }
        let list = model.snapshot.prioritized
        guard list.count > 3 else { print("ui-check: not enough agents"); return }
        let waitingNow = model.waiting.count
        report("Dock badge counts the agents waiting on you", NSApp.dockTile.badgeLabel == (waitingNow > 0 ? "\(waitingNow)" : ""), "badge=\(NSApp.dockTile.badgeLabel ?? "nil") waiting=\(waitingNow)")
        model.select(list[list.count / 2].id); await wait(1.5)
        report("agent mode streams the selected pane", model.primary.state == .live && model.primary.stats.frames > 0, "state=\(model.primary.state)")

        // Text size: the largest at which Herdr's grid fits the room, following the window, with zoom on top.
        if let e = model.primary.engine as? SwiftTermEngine, let host = e.view.superview, let win = Capture.mainWindow() {
            let savedZoom = model.paneZoom, savedSize = win.contentView?.frame.size ?? .zero
            func room() -> String { "view \(Int(e.view.frame.width))x\(Int(e.view.frame.height)) in \(Int(host.bounds.width))x\(Int(host.bounds.height)), \(e.view.gridCols)x\(e.view.gridRows) cells" }
            func fitsRoom() -> Bool { e.view.frame.width <= host.bounds.width + 0.5 && e.view.frame.height <= host.bounds.height + 0.5 }
            // A window of a known size: an inert background window may open at the minimum size.
            win.setContentSize(NSSize(width: 1500, height: 900)); await wait(0.8)
            let startSize = win.contentView?.frame.size ?? savedSize
            model.setPaneZoom(1, remember: false); await wait(0.5)
            let base = e.view.fontPoints
            report("pane text fits the pane in width and height", fitsRoom(), "font=\(base) pt, \(room())")
            win.setContentSize(NSSize(width: startSize.width + 400, height: startSize.height + 250)); await wait(0.8)
            let big = e.view.fontPoints
            report("a larger window gives larger text, still fitting", big >= base && fitsRoom(), "font \(base) -> \(big) pt, \(room())")
            win.setContentSize(NSSize(width: 1000, height: 600)); await wait(0.8)
            let small = e.view.fontPoints
            report("a smaller window gives smaller text (cropped only below the 7 pt floor)", small <= base && (fitsRoom() || small == PaneFit.floorPoints), "font \(base) -> \(small) pt, \(room())")
            win.setContentSize(startSize); await wait(0.6)
            model.zoomPane(1); model.zoomPane(1); await wait(0.5)
            let zoomed = e.view.fontPoints
            report("zoom in makes the text larger than the fit", zoomed > base && model.paneZoom > 1, "zoom=\(model.paneZoom) font=\(zoomed) pt (fit \(base))")
            model.zoomPane(-1); model.zoomPane(-1); model.zoomPane(-1); await wait(0.5)
            report("zoom out makes the text smaller than the fit", e.view.fontPoints < base && fitsRoom(), "zoom=\(model.paneZoom) font=\(e.view.fontPoints) pt")
            model.resetPaneZoom(); await wait(0.5)
            report("reset returns to the fit", abs(e.view.fontPoints - base) < 0.01 && model.paneZoom == 1, "font=\(e.view.fontPoints) pt")
            model.setPaneZoom(savedZoom, remember: false)
            win.setContentSize(savedSize); await wait(0.3)
        } else {
            print("ui-check: SKIP pane text size (the grid renderer is on, or no pane)")
        }

        model.mode = .editor; await wait(0.5)
        report("editor mode stops the pane stream", model.primary.paneID == nil && model.primary.processID == nil, "pane=\(model.primary.paneID ?? "nil")")
        model.mode = .herdr; await wait(0.3)
        report("herdr screen mode keeps streams stopped", model.primary.paneID == nil)
        model.mode = .agent; await wait(2)
        report("back in agent mode the stream restarts", model.primary.state == .live && model.primary.paneID == model.selectedPaneID, "state=\(model.primary.state)")

        model.toggleCompare(); await wait(2)
        report("compare opens a second live stream", model.comparePaneID != nil && model.secondary.state == .live, "state=\(model.secondary.state)")
        model.toggleCompare(); await wait(0.5)
        report("closing compare stops the second stream", model.comparePaneID == nil && model.secondary.paneID == nil)

        model.privacy = true; model.openHistory(); await wait(0.3)
        report("privacy mode refuses the history view", model.primaryHistory == nil)
        model.privacy = false
        // A working agent, so "the stream keeps running" can be seen as frames still arriving under the history.
        let working = model.snapshot.agents.first { $0.state == .working }
        if let w = working { model.select(w.id); await wait(1.5) }
        let framesBefore = model.primary.stats.frames
        model.openHistory(); await wait(0.1)
        report("history swaps in at once (loading)", model.primaryHistory != nil)
        await wait(2)
        let h = model.primaryHistory
        report("history loads as text", h?.text != nil, h.map { "\($0.phase == .loading ? "still loading" : ($0.text.map { "lines=\($0.split(separator: "\n", omittingEmptySubsequences: false).count)" } ?? "failed"))" } ?? "no history")
        if working != nil {
            report("the live stream keeps delivering frames under the history", model.primary.state == .live && model.primary.stats.frames > framesBefore, "frames \(framesBefore) -> \(model.primary.stats.frames)")
        } else {
            report("the live stream keeps running under the history (no working agent to see frames from)", model.primary.state == .live && model.primary.processID != nil, "state=\(model.primary.state)")
        }
        model.refreshHistory(); await wait(1.5)
        report("refresh reloads the history", model.primaryHistory?.text != nil)
        let t0 = monotonicNanos()
        model.toggleHistory(); await wait(0.4)
        report("back to live removes the history view", model.primaryHistory == nil)
        if model.primary.engine is SwiftTermEngine {
            let draw = DrawLog.shared.firstDraw(after: t0)
            report("the live pane is redrawn at once on the way back", draw != nil, draw.map { "\(String(format: "%.0f", Double($0 - t0) / 1e6)) ms" } ?? "no draw")
        }
        model.openHistory(); await wait(0.3)
        model.cycle(1); await wait(0.4)
        report("choosing another agent shows its live pane, not the old history", model.primaryHistory == nil)
        model.cycle(-1); await wait(0.3)
        model.openHistory(); await wait(0.3)
        model.privacy = true; await wait(0.2)
        report("turning privacy on closes the history view", model.primaryHistory == nil)
        model.privacy = false

        func nodes(_ box: WebBox) async -> Int {
            let probe: String = await withCheckedContinuation { c in box.probe { c.resume(returning: $0) } }
            return (probe.range(of: "\"nodes\":(\\d+)", options: .regularExpression)).flatMap { Int(probe[$0].dropFirst(8)) } ?? 0
        }
        func shown(_ box: WebBox) -> String { "frame=\(Int(box.webView.frame.width))x\(Int(box.webView.frame.height)) inWindow=\(box.webView.window != nil) hidden=\(box.webView.isHiddenOrHasHiddenAncestor)" }
        model.webTab = .organizer; model.pinReader(); await wait(3)
        let organizerNodes = await nodes(model.web.box(.organizer))
        report("organizer tab loads", model.web.box(.organizer).phase == .ready && organizerNodes > 50, "phase=\(model.web.box(.organizer).phase) nodes=\(organizerNodes) \(shown(model.web.box(.organizer)))")
        // The way a person gets from the organizer back to the reader: the segmented control (tab, then pin).
        model.webTab = .reader; model.pinReader(); await wait(6)
        let reader = model.web.box(.reader)
        let readerNodes = await nodes(reader)
        report("switching from the organizer to the reader tab loads the reader", reader.phase == .ready && readerNodes > 50 && reader.webView.window != nil, "phase=\(reader.phase) nodes=\(readerNodes) url=\(reader.webView.url?.host ?? "-"):\(reader.webView.url?.port ?? 0) \(shown(reader))")
        model.webTab = .organizer; model.pinReader(); await wait(2)
        report("and back to the organizer", model.web.box(.organizer).phase == .ready && model.web.box(.organizer).webView.window != nil, "phase=\(model.web.box(.organizer).phase) \(shown(model.web.box(.organizer)))")
        // The organizer opens on its Context view, whatever view it was last on.
        func organizerView() async -> String { await withCheckedContinuation { c in model.web.box(.organizer).selectedOrganizerView { c.resume(returning: $0 ?? "none") } } }
        let organizerBox = model.web.box(.organizer)
        let first = await organizerView()
        report("the organizer opens on its Context view", first == "context", "view=\(first)")
        _ = try? await organizerBox.webView.evaluateJavaScript("document.querySelector('[data-view=\"workspaces\"]').click()")
        await wait(0.5)
        let moved = await organizerView()
        model.webTab = .reader; await wait(0.4); model.webTab = .organizer; await wait(1.2)
        let again = await organizerView()
        report("switching to the Organizer tab shows Context again, not the view it was left on", moved == "workspaces" && again == "context", "left on=\(moved) reopened on=\(again)")
        organizerBox.reload(); await wait(4)
        let reloaded = await organizerView()
        report("a reloaded organizer page opens on Context", reloaded == "context", "view=\(reloaded)")

        // Links between Helm's panes stay in Helm; links that leave open in the browser (recorded here, never opened).
        final class Spy { var urls: [URL] = [] }
        let spy = Spy()
        organizerBox.openInBrowser = { spy.urls.append($0) }
        // The reader normalises its own hash after it loads (`#s=` becomes the id prefix of the session it selected), so the
        // check asks for real sessions of this Herdr and compares the first eight characters.
        let sessionIDs = model.snapshot.agents.compactMap(\.sessionID).filter { $0.count >= 8 }
        let sid1 = sessionIDs.first ?? "00000000", sid2 = sessionIDs.dropFirst().first ?? sid1
        let readerAddress = "http://localhost:8768/setup/transcript-reader/out/prototype.html#s=\(sid1)"
        func click(_ href: String, target: String?) async {
            let t = target.map { " target=\"\($0)\"" } ?? ""
            _ = try? await organizerBox.webView.evaluateJavaScript("(function(){var a=document.createElement('a');a.href='\(href)';\(t.isEmpty ? "" : "a.target='\(target!)';")document.body.appendChild(a);a.click();a.remove();})()")
        }
        model.webTab = .organizer; await wait(0.5)
        await click(readerAddress, target: nil); await wait(5)
        let readerBox = model.web.box(.reader)
        report("an organizer link to the reader switches Helm to the Reader tab and loads that exact address (hash kept)", model.webTab == .reader && readerBox.webView.url?.path == "/setup/transcript-reader/out/prototype.html" && readerBox.webView.url?.port == 8768 && (readerBox.webView.url?.fragment ?? "").hasPrefix("s=\(sid1.prefix(8))") && spy.urls.isEmpty,
               "tab=\(model.webTab.rawValue) url=\(readerBox.webView.url?.absoluteString ?? "-") phase=\(readerBox.phase) openedInBrowser=\(spy.urls.count)")
        model.webTab = .organizer; await wait(1)
        let blank = "http://127.0.0.1:8768/setup/transcript-reader/out/prototype.html#s=\(sid2)"
        await click(blank, target: "_blank"); await wait(5)
        report("the same through target=_blank (a new-window request), at another name for the same server", model.webTab == .reader && readerBox.webView.url?.host == "127.0.0.1" && (readerBox.webView.url?.fragment ?? "").hasPrefix("s=\(sid2.prefix(8))") && spy.urls.isEmpty,
               "tab=\(model.webTab.rawValue) url=\(readerBox.webView.url?.absoluteString ?? "-") openedInBrowser=\(spy.urls.count)")
        model.webTab = .organizer; await wait(1)
        await click("https://example.com/helm-check", target: nil); await wait(0.5)
        report("a link to an outside site is handed to the browser and leaves Helm where it is", model.webTab == .organizer && spy.urls.map(\.absoluteString) == ["https://example.com/helm-check"], "tab=\(model.webTab.rawValue) opened=\(spy.urls.map(\.absoluteString))")
        organizerBox.openInBrowser = { NSWorkspace.shared.open($0) }
        model.webTab = .reader; model.pinReader(); await wait(0.5)

        model.showSwitcher = true; model.switcherQuery = "agent"; await wait(0.3)
        report("quick switcher opens", model.showSwitcher)
        model.showSwitcher = false; model.switcherQuery = ""

        let before = model.selectedPaneID
        model.cycle(1); await wait(0.3)
        report("next agent changes the selection", model.selectedPaneID != before)

        model.inactivePauseSeconds = 1
        model.appResigned(); await wait(2.2)
        report("background pause stops the stream", !model.attentive && model.primary.paneID == nil, "attentive=\(model.attentive)")
        model.appBecameActive(); await wait(2)
        report("returning to the app restarts the stream", model.attentive && model.primary.state == .live, "state=\(model.primary.state)")
        // The menus SwiftUI built from the commands, with their shortcuts.
        var chords = 0
        var offenders: [String] = []
        func audit(_ i: NSMenuItem) {
            guard !i.keyEquivalent.isEmpty else { return }
            let f = i.keyEquivalentModifierMask
            if f.contains(.function) { return }        // the system's own Fn items (Start Dictation, Emoji & Symbols)
            chords += 1
            var m: KeyModifiers = []
            if f.contains(.command) { m.insert(.command) }
            if f.contains(.control) { m.insert(.control) }
            if f.contains(.option) { m.insert(.option) }
            if f.contains(.shift) { m.insert(.shift) }
            if ![.app, .toggleFocus].contains(KeyRule.route(KeyChord(i.keyEquivalent, m))) { offenders.append("\(i.title) [\(i.keyEquivalent)]") }
        }
        func dump(_ m: NSMenu, _ indent: String) {
            for i in m.items where !i.isSeparatorItem {
                audit(i)
                let key = i.keyEquivalent.isEmpty ? "" : " [\(i.keyEquivalentModifierMask.contains(.control) ? "^" : "")\(i.keyEquivalentModifierMask.contains(.option) ? "~" : "")\(i.keyEquivalentModifierMask.contains(.shift) ? "$" : "")\(i.keyEquivalentModifierMask.contains(.command) ? "@" : "")\(i.keyEquivalent)]"
                if let sub = i.submenu, !["Services"].contains(i.title) { print("ui-check: menu \(indent)\(i.title)"); dump(sub, indent + "  ") } else { print("ui-check: menu \(indent)\(i.title)\(key)\(i.isEnabled ? "" : " (disabled)")") }
            }
        }
        if let main = NSApp.mainMenu { dump(main, "") }
        report("every menu shortcut carries Command (Ctrl and Alt chords stay the pane's)", chords > 0 && offenders.isEmpty, "shortcuts=\(chords) offenders=\(offenders)")
        print("ui-check: done")
        model.shutdown(); NSApplication.shared.terminate(nil)
    }
}
