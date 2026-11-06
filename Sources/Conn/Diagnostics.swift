// Self test: prints counts and timings only, never terminal text or page content, so it is safe to run against a live
// Herdr session.
import SwiftUI
import WebKit
import ConnCore
import ConnTerminal
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
        for (i, box) in model.watch.boxes.values.enumerated() {
            print("web watch column \(i): phase=\(box.phase) loadSeconds=\(box.loadSeconds.map { String(format: "%.2f", $0) } ?? "n/a") pid=\(box.pid ?? -1) footprintMB=\(box.pid.flatMap { ProcessUsage.read($0) }.map { String(format: "%.0f", Double($0.footprint) / ProcessUsage.mebibyte) } ?? "n/a")")
        }
        print("watch: on=\(model.watchOn) columns=\(model.watch.layout.openCount)/\(model.watch.count) readerBox=\(model.web.readerBox == nil ? "unloaded" : "loaded")")
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
                if let path = ProcessInfo.processInfo.environment["CONN_LAYER_PNG"], let cg = ctx.makeImage() {
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
        // SwiftUI builds the menus once, from the flag the launch had; flipping the flag in this process does not rebuild them. A check
        // that needs the Agent view's menu items runs only when the launch had it on (`--agent-view`), and says so when it does not.
        let menusHaveAgentView = model.agentViewEnabled
        func menuReport(_ name: String, _ ok: Bool, _ detail: String = "") {
            if menusHaveAgentView { report(name, ok, detail) } else { print("ui-check: SKIP \(name) (the menus of this launch were built with the Agent view off; run with --agent-view)") }
        }
        await wait(4)
        if Runtime.config.runsInBackground {
            let wins = NSApp.windows.filter { $0.isVisible }
            report("test mode keeps the app out of the way (accessory, not active, no key window, windows invisible and click-through)",
                   NSApp.activationPolicy() == .accessory && !NSApp.isActive && !wins.contains { $0.isKeyWindow } && wins.allSatisfy { $0.alphaValue == 0 && $0.ignoresMouseEvents },
                   "policy=\(NSApp.activationPolicy().rawValue) active=\(NSApp.isActive) windows=\(wins.count) keyWindows=\(wins.filter { $0.isKeyWindow }.count) alpha=\(wins.map { $0.alphaValue })")
        }
        // A person's own launch opens on the Herdr client view and attaches its client; this scripted launch must do neither,
        // so the checks below run on the Agent view and never put a second client on the session.
        // With the Agent view off (the default) a scripted launch opens on the Herdr client view instead, still without attaching.
        let launchedWithAgentView = model.agentViewEnabled
        let expectedMode: CenterMode = launchedWithAgentView ? .agent : .herdr
        report("a scripted launch opens on the \(expectedMode.rawValue) view (the Agent view only when its flag is on) and does not attach the Herdr client",
               Runtime.config.isScriptedLaunch && !Runtime.config.launchPlan.attachesClient && model.mode == expectedMode && !model.fallback.running,
               "agentViewFlag=\(launchedWithAgentView) scripted=\(Runtime.config.isScriptedLaunch) attaches=\(Runtime.config.launchPlan.attachesClient) mode=\(model.mode.rawValue) clientRunning=\(model.fallback.running)")
        let list = model.snapshot.prioritized
        guard list.count > 3 else { print("ui-check: not enough agents"); return }
        // The Agent view off: nothing reaches it. Then the flag is switched on in this process, for every check below that needs the Agent view.
        await AgentViewCheck.runOff(model: model, menusMatchFlag: !launchedWithAgentView, report: report, wait: wait)
        model.agentViewEnabled = true; model.mode = .agent; await wait(1)
        print("ui-check: info the Agent view flag is switched on in this process for the checks below (launched \(launchedWithAgentView ? "on" : "off"))")
        let waitingNow = model.waiting.count
        report("Dock badge counts the agents waiting on you", NSApp.dockTile.badgeLabel == (waitingNow > 0 ? "\(waitingNow)" : ""), "badge=\(NSApp.dockTile.badgeLabel ?? "nil") waiting=\(waitingNow)")
        model.select(list[list.count / 2].id); await wait(1.5)
        report("agent mode streams the selected pane", model.primary.state == .live && model.primary.stats.frames > 0, "state=\(model.primary.state) mode=\(model.mode.rawValue) pane=\(model.primary.paneID ?? "nil") selected=\(model.selectedPaneID ?? "nil") attentive=\(model.attentive) windowVisible=\(model.windowVisible)")

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
            let cellInfo = [7.0, 7.5, 8.0, 9.0, 10.0].map { p in "\(p)pt=\(ConnTerminalView.cellSize(forPoints: CGFloat(p), scale: 2).width)x\(ConnTerminalView.cellSize(forPoints: CGFloat(p), scale: 2).height)" }.joined(separator: " ")
            report("pane text fits the pane in width and height", fitsRoom(), "font=\(base) pt, \(room()); mirrored cell sizes \(cellInfo); view cell=\(e.view.frame.width / CGFloat(e.view.gridCols))")
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

        // Events built and delivered inside this process: they are never posted to the system, so they cannot touch the real
        // pointer or the focus of another app. Wheel events go straight to the pane's responder method; key events go through
        // the app's own menu (`performKeyEquivalent`), the way a real key press reaches a menu shortcut.
        if let win = Capture.mainWindow() {
            func scrollEvent(_ dy: Int32) -> NSEvent? {
                guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { return nil }
                cg.timestamp = mach_absolute_time()
                return NSEvent(cgEvent: cg)
            }
            func keyEvent(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) -> NSEvent? {
                NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                 windowNumber: win.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)
            }
            func press(_ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) -> Bool {
                guard let e = keyEvent(chars, code, flags) else { return false }
                return NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false
            }
            let originalZoom = model.paneZoom
            model.setPaneZoom(1); await wait(0.3)
            let up = press("=", 24, [.command]); await wait(0.3)
            menuReport("Cmd+= makes the pane text bigger", up && model.paneZoom == 1.1, "zoom=\(model.paneZoom)")
            let d1 = press("-", 27, [.command]); await wait(0.3); let z1 = model.paneZoom
            let d2 = press("-", 27, [.command]); await wait(0.3)
            menuReport("Cmd+- makes it smaller", d1 && z1 == 1.0 && d2 && model.paneZoom == 0.9, "zoom \(z1) then \(model.paneZoom)")
            let reset = press("0", 29, [.command]); await wait(0.3)
            menuReport("Cmd+0 returns to the fit", reset && model.paneZoom == 1.0, "zoom=\(model.paneZoom)")
            model.closeHistory(); await wait(0.2)
            // The menu runs its action on a later turn of the run loop, so each press is followed by a short wait.
            let handled1 = press("y", 16, [.command]); await wait(0.3); let opened = model.primaryHistory != nil
            let handled2 = press("y", 16, [.command]); await wait(0.3); let closed = model.primaryHistory == nil
            menuReport("Cmd+Y swaps in the history and Cmd+Y swaps it out", handled1 && opened && handled2 && closed, "handled=\(handled1)/\(handled2) opened=\(opened) closed=\(closed) mode=\(model.mode.rawValue) privacy=\(model.privacy) agent=\(model.selectedAgent?.name ?? "nil")")
            // Ownership rule: no menu shortcut claims a Ctrl or Alt chord without Command, so those keys stay the pane's.
            func stateKey() -> String {
                "\(model.paneZoom)|\(model.primaryHistory != nil)|\(model.selectedPaneID ?? "-")|\(model.mode.rawValue)|\(model.privacy)|\(model.showSwitcher)|\(model.showWeb)|\(model.sidebarVisible)|\(model.comparePaneID ?? "-")"
            }
            let before = stateKey()
            var claimed: [String] = []
            for (chars, code) in [("=", UInt16(24)), ("-", 27), ("0", 29), ("y", 16), ("j", 38), ("k", 40), ("1", 18), ("2", 19), ("[", 33), ("]", 30), ("\\", 42), ("l", 37), ("r", 15), ("s", 1), ("f", 3), ("b", 11), ("n", 45), ("o", 31), ("w", 13), ("g", 5)] {
                for (name, flags) in [("Ctrl", NSEvent.ModifierFlags.control), ("Alt", .option), ("Ctrl+Alt", [.control, .option]), ("Ctrl+Shift", [.control, .shift]), ("Alt+Shift", [.option, .shift])] where press(chars, code, flags) { claimed.append("\(name)+\(chars)") }
            }
            await wait(0.3)
            let after = stateKey()
            report("no menu shortcut claims a Ctrl or Alt chord (they stay the pane's), and nothing changed", claimed.isEmpty && before == after, "claimed=\(claimed) unchanged=\(before == after)")
            // The wheel over the pane. The host takes scroll events itself; one upward gesture opens the history, once.
            if let host = (model.primary.engine as? SwiftTermEngine)?.view.superview as? PaneHostView {
                for dy in [Int32(-6), -6, -6, 3, 2] { if let e = scrollEvent(dy) { host.scrollWheel(with: e) } }
                report("a downward scroll or a small flick over the pane does not open the history", model.primaryHistory == nil)
                try? await Task.sleep(nanoseconds: 600_000_000)       // a pause ends the gesture
                for _ in 0..<6 { if let e = scrollEvent(6) { host.scrollWheel(with: e) } }
                report("a deliberate upward scroll over the pane opens its history", model.primaryHistory != nil)
                model.closeHistory(); await wait(0.3)
            } else {
                print("ui-check: SKIP wheel over the pane (the grid renderer is on)")
            }
            model.setPaneZoom(originalZoom)
            print("ui-check: info window occlusionVisible=\(win.occlusionState.contains(.visible)) alpha=\(win.alphaValue) appNapHeld=\(Runtime.config.runsInBackground) windowScale=\(win.backingScaleFactor) screenScale=\(win.screen?.backingScaleFactor ?? 0) mainScreenScale=\(NSScreen.main?.backingScaleFactor ?? 0)")
        }

        model.mode = .editor; await wait(0.5)
        report("editor mode stops the pane stream", model.primary.paneID == nil && model.primary.processID == nil, "pane=\(model.primary.paneID ?? "nil")")
        model.mode = .herdr; await wait(0.3)
        report("herdr screen mode keeps streams stopped", model.primary.paneID == nil)
        model.mode = .agent; await wait(2)
        report("back in agent mode the stream restarts", model.primary.state == .live && model.primary.paneID == model.selectedPaneID, "state=\(model.primary.state)")

        // View order: Herdr client first, then Agent, then Editor, in the switcher, the Layout menu and Opt+Cmd+1/2/3.
        let order = CenterMode.allCases.map(\.rawValue)
        report("the views are Herdr client, Agent, Editor, in that order", order == ["Herdr client", "Agent", "Editor"], "order=\(order)")
        let chordMask: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
        if let layout = NSApp.mainMenu?.items.first(where: { $0.title == "Layout" })?.submenu {
            let first = Array(layout.items.prefix(3))
            menuReport("the Layout menu lists the views in that order with Opt+Cmd+1/2/3",
                   first.map(\.title) == order && first.map(\.keyEquivalent) == ["1", "2", "3"] && first.allSatisfy { $0.keyEquivalentModifierMask.intersection(chordMask) == [.command, .option] },
                   "items=\(first.map { "\($0.title) [\($0.keyEquivalent)]" })")
        } else {
            menuReport("the Layout menu lists the views in that order with Opt+Cmd+1/2/3", false, "no Layout menu")
        }
        if let win = Capture.mainWindow() {
            func optCmd(_ digit: String, _ code: UInt16) async -> Bool {
                guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.command, .option], timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: win.windowNumber, context: nil, characters: digit, charactersIgnoringModifiers: digit, isARepeat: false, keyCode: code) else { return false }
                let handled = NSApp.mainMenu?.performKeyEquivalent(with: e) ?? false
                await wait(0.4)     // the menu runs its action on a later turn of the run loop
                return handled
            }
            let h1 = await optCmd("1", 18); let m1 = model.mode, running1 = model.fallback.running
            let h2 = await optCmd("2", 19); let m2 = model.mode
            let h3 = await optCmd("3", 20); let m3 = model.mode
            menuReport("Opt+Cmd+1 is the Herdr client, Opt+Cmd+2 the Agent view and Opt+Cmd+3 the Editor; the shortcut does not attach the client",
                   h1 && m1 == .herdr && !running1 && h2 && m2 == .agent && h3 && m3 == .editor, "handled=\(h1)/\(h2)/\(h3) modes=\(m1.rawValue)/\(m2.rawValue)/\(m3.rawValue) clientRunning=\(running1)")
            _ = await optCmd("2", 19); await wait(2)
            menuReport("Opt+Cmd+2 brings the Agent view and its stream back", model.mode == .agent && model.primary.state == .live, "mode=\(model.mode.rawValue) state=\(model.primary.state)")
        }
        if !menusHaveAgentView { model.mode = .agent; await wait(2) }     // the Opt+Cmd+2 steps above were skipped: go back to the Agent view by hand
        await AgentViewCheck.runOn(model: model, report: report, wait: wait)
        await wait(2)

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
            // On the stand-in a working pane prints every 250 ms, so frames must arrive; a real agent can be quiet for two
            // seconds, so there the stream only has to be alive (its observer child running).
            let alive = model.primary.state == .live && model.primary.processID != nil
            let arrived = model.primary.stats.frames > framesBefore
            report("the live stream keeps delivering frames under the history", model.config.fixture ? (alive && arrived) : (alive || arrived), "frames \(framesBefore) -> \(model.primary.stats.frames), stream alive=\(alive)")
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
        // What a person sees. "Loaded, and in the window" does not say which page is in front: both web views can sit under
        // one host view (the segmented control swaps the box under the same SwiftUI view). So this asks which web view a click
        // in the middle of the column would reach, after each tab switch, from a column built showing either pane first.
        // No click is made inside either page.
        func pageInFront(_ selected: WebBox) -> String {
            guard let host = selected.webView.superview, let root = host.window?.contentView?.superview else { return "not in the window" }
            let hit = root.hitTest(host.convert(NSPoint(x: host.bounds.midX, y: host.bounds.midY), to: nil))
            var v = hit
            while let x = v, !(x is WKWebView) { v = x.superview }
            guard let web = v as? WKWebView else { return "no page (hit \(hit.map { String(describing: type(of: $0)) } ?? "nothing"), phase \(selected.phase))" }
            return model.web.allBoxes.first { $0.webView === web }?.kind.rawValue ?? "other page"
        }
        // A load that replaces one still in flight cancels it, and the box briefly shows "not reachable" (NSURLErrorCancelled)
        // until the newer load finishes. That is a separate matter from which page is in front, so each step waits for the page to settle.
        func settled(_ box: WebBox) async { var n = 0; while box.phase != .ready && n < 40 { await wait(0.2); n += 1 } }
        func tabsShowTheirOwnPage(first: WebKind, then order: [WebKind]) async {
            model.showWeb = false; await wait(0.5)
            model.webTab = first; model.showWeb = true; await wait(1); await settled(model.web.box(first))
            var trail = ["\(first.rawValue)->\(pageInFront(model.web.box(first)))"]
            var wrong = trail[0].hasSuffix("->\(first.rawValue)") ? 0 : 1
            for (i, kind) in order.enumerated() {
                model.webTab = kind; model.pinReader(); await wait(0.7); await settled(model.web.box(kind))
                let front = pageInFront(model.web.box(kind))
                trail.append("\(kind.rawValue)->\(front)")
                if front != kind.rawValue { wrong += 1 }
                if model.config.fixture, let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] {
                    await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("\(first.rawValue.lowercased())-first-\(i + 1)-\(kind.rawValue.lowercased())-tab.png"))
                }
            }
            let inWindow = model.web.allBoxes.filter { $0.webView.window != nil }.map { $0.kind.rawValue }
            report("tabs switched from a column that showed the \(first.rawValue) first: the selected tab's page is the one in front", wrong == 0, "\(trail.joined(separator: " ")); in the window at the end: \(inWindow)")
        }
        await tabsShowTheirOwnPage(first: .reader, then: [.organizer, .reader, .organizer, .reader, .reader])
        await tabsShowTheirOwnPage(first: .organizer, then: [.reader, .organizer, .reader, .organizer])
        model.webTab = .organizer; model.pinReader(); await wait(2)
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

        // Links between Conn's panes stay in Conn; links that leave open in the browser (recorded here, never opened).
        // The pages' real addresses are http://localhost:8768 and :8765, so this part needs the live servers.
        if model.config.fixture {
            print("ui-check: SKIP links between the reader and organizer servers (the fixture pages are local files; WebLinkPolicyTests cover the rule)")
        } else {
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
        report("an organizer link to the reader switches Conn to the Reader tab and loads that exact address (hash kept)", model.webTab == .reader && readerBox.webView.url?.path == "/setup/transcript-reader/out/prototype.html" && readerBox.webView.url?.port == 8768 && (readerBox.webView.url?.fragment ?? "").hasPrefix("s=\(sid1.prefix(8))") && spy.urls.isEmpty,
               "tab=\(model.webTab.rawValue) url=\(readerBox.webView.url?.absoluteString ?? "-") phase=\(readerBox.phase) openedInBrowser=\(spy.urls.count)")
        model.webTab = .organizer; await wait(1)
        let blank = "http://127.0.0.1:8768/setup/transcript-reader/out/prototype.html#s=\(sid2)"
        await click(blank, target: "_blank"); await wait(5)
        report("the same through target=_blank (a new-window request), at another name for the same server", model.webTab == .reader && readerBox.webView.url?.host == "127.0.0.1" && (readerBox.webView.url?.fragment ?? "").hasPrefix("s=\(sid2.prefix(8))") && spy.urls.isEmpty,
               "tab=\(model.webTab.rawValue) url=\(readerBox.webView.url?.absoluteString ?? "-") openedInBrowser=\(spy.urls.count)")
        model.webTab = .organizer; await wait(1)
        await click("https://example.com/conn-check", target: nil); await wait(0.5)
        report("a link to an outside site is handed to the browser and leaves Conn where it is", model.webTab == .organizer && spy.urls.map(\.absoluteString) == ["https://example.com/conn-check"], "tab=\(model.webTab.rawValue) opened=\(spy.urls.map(\.absoluteString))")
        organizerBox.openInBrowser = { NSWorkspace.shared.open($0) }
        }
        model.webTab = .reader; model.pinReader(); await wait(0.5)

        await StarredBarCheck.run(model: model, report: report, wait: wait)
        model.webTab = .reader; model.pinReader(); await wait(0.5)
        await ReaderPinCheck.run(model: model, report: report, wait: wait)
        model.webTab = .reader; model.pinReader(); await wait(0.5)
        await WatchCheck.run(model: model, report: report, wait: wait)
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
            if f.contains(.function) || i.keyEquivalent.unicodeScalars.contains(where: { $0.value >= 0xF000 }) { return }        // the system's own Fn items (Start Dictation, Emoji & Symbols)
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
