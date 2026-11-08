// `--ui-check` steps for Conn Focus (README "Focus sessions"; `./run.sh --fixture --focus-check` runs only these). The launch is a scripted one, so the coordinator runs on stand-ins
// and a hand-moved clock (`FocusRuntime`): no sound, no `shortcuts run`, no Focus change, no panel on a screen, and a marker folder of its own under the temporary folder.
// What is checked is what a person would meet: the toolbar pill in each state (drawn and read as pixels, since SwiftUI builds no accessibility tree for an inert background
// window; see StarredBarCheck), the session through start, pause, +5 min, the end, Restart and stop early, the marker file at every step, Conn Focus On and Off, the red
// warning and Try again, the eye break (the panel's properties, where it would go, Skip, Snooze, the end, the away rule), Privacy mode, the Focus menu, and the daily total.
// `CONN_UI_CHECK_SHOT_DIR=DIR` also writes a picture of each state, which is looked at by eye.
import SwiftUI
import AppKit
import ConnCore

@MainActor
enum FocusCheck {
    static func runAlone(model: AppModel) async {
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func report(_ name: String, _ ok: Bool, _ detail: String = "") { print("ui-check: \(ok ? "PASS" : "FAIL") \(name) \(detail)") }
        await wait(4)
        await run(model: model, report: report, wait: wait)
        print("ui-check: done")
        model.shutdown()
        NSApplication.shared.terminate(nil)
    }

    /// The view as the pixels it draws, in the light appearance. It is added to the main window's content (which is invisible and click-through in test mode) for the moment
    /// it takes to draw it, then taken out again: a view that is not in a window draws none of its AppKit controls (buttons, switches, the progress bar). With `opaque` the
    /// window's own background is drawn behind it, as a popover has one.
    static func render<V: View>(_ v: V, scale: CGFloat = 2, opaque: Bool = false) async -> (rep: NSBitmapImageRep, size: CGSize)? {
        let host = NSHostingView(rootView: AnyView(v.background(opaque ? Color(nsColor: .windowBackgroundColor) : Color.clear).ignoresSafeArea()))
        host.appearance = NSAppearance(named: .aqua)
        let size = host.fittingSize
        guard size.width > 0, size.height > 0 else { return nil }
        // Without a window of the app to borrow, a window of its own that is never ordered onto a screen.
        let own = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: true)
        own.isReleasedWhenClosed = false
        if let content = Capture.mainWindow()?.contentView { content.addSubview(host) } else { own.contentView = host }
        defer { host.removeFromSuperview() }
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        // One turn of the run loop, so SwiftUI has committed its first frame before it is drawn.
        try? await Task.sleep(nanoseconds: 120_000_000)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        host.cacheDisplay(in: host.bounds, to: rep)
        return (rep, size)
    }

    /// A view of plain SwiftUI shapes and text (no AppKit controls) as pixels, drawn by SwiftUI itself: no window is needed.
    static func renderPlain<V: View>(_ v: V, scale: CGFloat = 2) -> (rep: NSBitmapImageRep, size: CGSize)? {
        let r = ImageRenderer(content: v.environment(\.colorScheme, .light))
        r.scale = scale
        guard let cg = r.cgImage else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        let size = CGSize(width: CGFloat(cg.width) / scale, height: CGFloat(cg.height) / scale)
        rep.size = size
        return (rep, size)
    }

    /// How many pixels are opaque and close to `color`.
    static func pixels(_ rep: NSBitmapImageRep, near color: NSColor, tolerance: CGFloat = 0.10) -> Int {
        guard let px = StarredBarCheck.Pixels(rep), let c = color.usingColorSpace(.deviceRGB) else { return 0 }
        var n = 0
        for y in 0..<px.height { for x in 0..<px.width {
            guard px.alpha(x, y) > 0.9 else { continue }
            let p = px.rgb(x, y)
            if abs(p[0] - c.redComponent) < tolerance && abs(p[1] - c.greenComponent) < tolerance && abs(p[2] - c.blueComponent) < tolerance { n += 1 }
        } }
        return n
    }

    static func opaqueShare(_ rep: NSBitmapImageRep) -> Double {
        guard let px = StarredBarCheck.Pixels(rep), px.width * px.height > 0 else { return 0 }
        var n = 0
        for y in 0..<px.height { for x in 0..<px.width where px.alpha(x, y) > 0.5 { n += 1 } }
        return Double(n) / Double(px.width * px.height)
    }

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard let si = model.focusStandIns, let clock = si.clock, let ticker = si.ticker else {
            print("ui-check: SKIP Conn Focus (this launch is not on the stand-ins and a hand-moved clock: use --ui-check or --focus-check)")
            return
        }
        let focus = model.focus, panel = model.focusPanel, sw = si.focusSwitch, chimes = si.chimes, presence = si.presence
        let markerFile = FocusMarkerFile(directory: si.markerDirectory)
        let shots = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"].map { URL(fileURLWithPath: $0) }
        func png(_ name: String, _ rep: NSBitmapImageRep) {
            guard let d = shots, let data = rep.representation(using: .png, properties: [:]) else { return }
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            try? data.write(to: d.appendingPathComponent(name))
        }
        func advance(_ s: TimeInterval) { clock.advance(by: s); focus.tick() }
        func settle() async { await focus.settled() }
        func pill(_ shotName: String? = nil) async -> (rep: NSBitmapImageRep, size: CGSize)? {
            focus.tick()
            let r = renderPlain(FocusPillLabel(focus: focus, face: focus.face).padding(4))
            if let r = r, let n = shotName { png(n, r.rep) }
            return r
        }

        // 0. Start from a clean slate: the eye clock off, no session, today's total empty (the test preferences, never a person's own).
        focus.setEyeEnabled(false)
        if focus.session.isActive { focus.stopEarly() }
        focus.dismissDone()
        await settle()
        AppModel.defaults.removeObject(forKey: FocusTotalsStore.defaultKey)
        let startedFresh = focus.session.isIdle && !markerFile.exists && focus.dayTotal(at: clock.now).focusedSeconds == 0
        report("Conn Focus: a scripted launch runs on stand-ins and a hand-moved clock, with a headless panel and its marker folder apart from Conn's own",
               startedFresh && panel.headless && si.markerDirectory.standardizedFileURL != FocusMarker.defaultDirectory().standardizedFileURL && sw.blockingCalls.isEmpty,
               "idle=\(focus.session.isIdle) headless=\(panel.headless) markerDir=\(si.markerDirectory.lastPathComponent)")
        sw.setResults([.done])
        let offsAtStart = sw.calls.filter { !$0 }.count

        // 1. Idle: the toolbar shows an icon, no countdown.
        let idle = await pill("focus-01-pill-idle.png")
        report("Focus pill: idle it is a small icon with no countdown and no fill", (idle?.size.width ?? 999) < 50 && idle.map { pixels($0.rep, near: NSColor(FocusStyle.focus)) == 0 } == true, "size=\(idle.map { "\(Int($0.size.width))x\(Int($0.size.height))" } ?? "none")")

        // 2. Start 25 minutes.
        focus.start(minutes: 25)
        await settle()
        let t0 = Int(clock.now.timeIntervalSince1970)
        let m1 = markerFile.read()
        report("Focus: Start runs a 25-minute session, asks for Conn Focus On once, sees it confirmed, and writes the marker file for other tools",
               focus.session.isRunning && sw.calls.suffix(1) == [true] && focus.link == .onConfirmed && m1 == FocusMarker(pid: getpid(), startedAt: t0, endsAt: t0 + 1500),
               "calls=\(sw.calls) link=\(focus.link) marker=\(m1.map { "\($0.pid) \($0.startedAt) \($0.endsAt.map(String.init) ?? "null")" } ?? "none")")
        report("Focus: a running session ticks every second (and the ticker is the stand-in's)", ticker.interval == 1, "interval=\(ticker.interval.map { "\($0)" } ?? "none")")
        let running = await pill("focus-02-pill-running.png")
        let widthRunning = running?.size.width ?? 999
        report("Focus pill: running it is a capsule in the Focus colour with the countdown, about 85 points wide, so it fits the toolbar's right-hand group",
               running.map { pixels($0.rep, near: NSColor(FocusStyle.focus)) > 40 } == true && widthRunning > 60 && widthRunning < 120,
               "width=\(Int(widthRunning)) focusPixels=\(running.map { pixels($0.rep, near: NSColor(FocusStyle.focus)) } ?? -1)")

        // 3. Pause keeps Conn Focus on (F15), the marker has no deadline; resume and +5 min write new deadlines.
        advance(600)
        focus.pauseSession()
        await settle()
        let paused = markerFile.read()
        report("Focus: Pause keeps Conn Focus on (no Off call), freezes the time left at 15:00 and writes the marker with a null deadline",
               focus.session.isPaused && sw.calls.suffix(1) == [true] && focus.link == .onConfirmed && paused?.endsAt == nil && paused?.startedAt == t0 && focus.session.remaining(at: clock.now) == 900,
               "calls=\(sw.calls) marker=\(paused.map { "\($0.endsAt.map(String.init) ?? "null")" } ?? "none")")
        _ = await pill("focus-03-pill-paused.png")
        advance(7200)
        report("Focus: a paused session does not run down or finish while the clock moves", focus.session.isPaused && focus.session.remaining(at: clock.now) == 900 && chimes.played.isEmpty, "remaining=\(focus.session.remaining(at: clock.now))")
        focus.resumeSession()
        let resumedEnd = markerFile.read()?.endsAt
        focus.extendSession()
        report("Focus: Resume and +5 min each rewrite the marker, the deadline is 20:00 after +5 min",
               focus.session.isRunning && resumedEnd == Int(clock.now.timeIntervalSince1970) + 900 && markerFile.read()?.endsAt == Int(clock.now.timeIntervalSince1970) + 1200,
               "resumedEnd=\(resumedEnd.map(String.init) ?? "nil") now=\(Int(clock.now.timeIntervalSince1970)) later=\(markerFile.read()?.endsAt.map(String.init) ?? "nil")")

        // 4. The end: a chime, Done, Conn Focus off at once (F16), the marker gone, nothing starts by itself.
        advance(1199)
        let beforeEnd = focus.session.isRunning && chimes.played.isEmpty && markerFile.exists
        advance(1)
        await settle()
        report("Focus: when the time is up the chime is requested, the session is Done, the marker is removed and Conn Focus is switched off at once",
               beforeEnd && focus.session.isDone && chimes.played == [.sessionEnded] && !markerFile.exists && sw.calls.suffix(1) == [false] && focus.link == .off,
               "chimes=\(chimes.played) calls=\(sw.calls) link=\(focus.link) marker=\(markerFile.exists)")
        let done = await pill("focus-04-pill-done.png")
        report("Focus pill: Done is a green capsule with a check and the word Done",
               done.map { pixels($0.rep, near: NSColor.systemGreen, tolerance: 0.14) > 30 } == true && (done?.size.width ?? 999) < 100, "greenPixels=\(done.map { pixels($0.rep, near: NSColor.systemGreen, tolerance: 0.14) } ?? -1)")
        advance(10_000)
        report("Focus: Done stays Done (no automatic restart) and the ticker has stopped", focus.session.isDone && sw.calls.suffix(1) == [false] && ticker.interval == nil, "interval=\(ticker.interval.map { "\($0)" } ?? "none") calls=\(sw.calls)")

        // 5. Restart repeats the length; Stop early goes back to the start and counts what was focused.
        focus.restart(); await settle()
        report("Focus: Restart repeats the 25 minutes and turns Conn Focus on again", focus.session.isRunning && focus.session.remaining(at: clock.now) == 1500 && sw.calls.suffix(2) == [false, true] && markerFile.exists, "calls=\(sw.calls)")
        advance(120)
        focus.stopEarly(); await settle()
        report("Focus: Stop early ends the session without a chime, removes the marker and switches Conn Focus off",
               focus.session.isIdle && !markerFile.exists && chimes.played == [.sessionEnded] && sw.calls.suffix(1) == [false] && focus.link == .off, "chimes=\(chimes.played) calls=\(sw.calls) link=\(focus.link)")
        let day = focus.dayTotal(at: clock.now)
        report("Focus: the daily total counts the focused time of both runs (30 min in the first, 2 min in the second, no pause time)", day.focusedSeconds == 1800 + 120, "focused=\(day.focusedSeconds) s")

        // 6. The red warning (decision F21): the shortcut fails, the pill turns red and says so; Try again fixes it.
        sw.setResults([.failed("Error: Couldn't find shortcut 'Conn Focus On'")])
        focus.start(minutes: 15); await settle()
        report("Focus: a failing Conn Focus On is a red warning (the session goes on without the Focus)",
               focus.session.isRunning && focus.link.isRed && focus.link == .didNotSwitchOn("the shortcut said: Error: Couldn't find shortcut 'Conn Focus On'"), "link=\(focus.link)")
        let red = await pill("focus-05-pill-red.png")
        report("Focus pill: with the warning it turns red with a triangle", red.map { pixels($0.rep, near: NSColor.systemRed, tolerance: 0.2) > 30 } == true, "redPixels=\(red.map { pixels($0.rep, near: NSColor.systemRed, tolerance: 0.2) } ?? -1)")
        if let r = await render(FocusPanelView(focus: focus, face: focus.face).environmentObject(model), opaque: true) { png("focus-06-popover-red.png", r.rep) }
        sw.setResults([.done])
        focus.retryFocus(); await settle()
        report("Focus: Try again runs Conn Focus On again and the warning clears", focus.link == .onConfirmed && sw.calls.suffix(2) == [true, true], "link=\(focus.link) calls=\(sw.calls)")
        focus.stopEarly(); await settle()

        // 7. The popover's other states, as pictures (the idle start view, running, done).
        if let r = await render(FocusPanelView(focus: focus, face: focus.face).environmentObject(model), opaque: true) { png("focus-07-popover-idle.png", r.rep) }
        focus.start(minutes: 45); await settle(); advance(300)
        if let r = await render(FocusPanelView(focus: focus, face: focus.face).environmentObject(model), opaque: true) { png("focus-08-popover-running.png", r.rep) }
        advance(2400); await settle()
        if let r = await render(FocusPanelView(focus: focus, face: focus.face).environmentObject(model), opaque: true) { png("focus-09-popover-done.png", r.rep) }
        focus.dismissDone()
        report("Focus: Choose another length goes from Done back to the start view", focus.session.isIdle, "phase=\(focus.session.phase)")
        if let r = await render(FocusSetupSheet(focus: focus).environmentObject(model), opaque: true) { png("focus-10-setup.png", r.rep) }

        // 8. The check of the setup lists and runs nothing.
        let callsBefore = sw.calls.count
        sw.setSetup(.missing([.off]))
        await focus.checkSetup()
        report("Focus: Check Focus Setup only lists the shortcuts, names the missing one and runs none", focus.setupStatus == .missing([.off]) && sw.calls.count == callsBefore && sw.setupChecks >= 1, "status=\(String(describing: focus.setupStatus))")
        sw.setSetup(.ready)

        // 9. The eye break.
        focus.setEyeEnabled(true)
        report("Eye: the 20-20-20 clock has its own switch and runs with no session (a look every 5 seconds while idle)", focus.eyeEnabled && focus.session.isIdle && ticker.interval == 5, "interval=\(ticker.interval.map { "\($0)" } ?? "none")")
        advance(1200)
        let up = focus.eye.isOnBreak
        report("Eye: after 20 minutes a break starts: the start chime is requested and the panel is asked to show, once",
               up && panel.isShowing && panel.presentedCount == 1 && chimes.played.last == .eyeBreakStarted, "onBreak=\(up) shown=\(panel.isShowing) presented=\(panel.presentedCount) chimes=\(chimes.played)")
        if let p = panel.panel {
            let behaviour: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .canJoinAllApplications]
            report("Eye panel: it never becomes key or main, floats above the menu bar on every Space and over full-screen apps, and was not ordered onto a screen in this test",
                   !p.canBecomeKey && !p.canBecomeMain && p.styleMask.contains(.nonactivatingPanel) && p.isFloatingPanel && p.becomesKeyOnlyIfNeeded && !p.hidesOnDeactivate && p.level == .statusBar
                    && p.collectionBehavior.isSuperset(of: behaviour) && !p.isVisible && !p.isKeyWindow,
                   "level=\(p.level.rawValue) behaviour=\(p.collectionBehavior.rawValue) visible=\(p.isVisible) key=\(p.isKeyWindow)")
            report("Eye panel: screen capture is allowed while Privacy mode is off", p.sharingType == .readOnly, "sharing=\(p.sharingType.rawValue)")
            model.privacy = true
            let hidden = p.sharingType == .none
            model.privacy = false
            report("Eye panel: Privacy mode hides it from screen capture and sharing (it still shows for the person), and turning Privacy off lets capture back", hidden && p.sharingType == .readOnly, "hidden=\(hidden) after=\(p.sharingType.rawValue)")
        } else {
            report("Eye panel: the panel exists after the first break", false, "no panel")
        }
        let screens = NSScreen.screens
        if let f = panel.lastFrame, let i = EyePanelPlacement.screenIndex(containing: NSEvent.mouseLocation, frames: screens.map(\.frame)) {
            let vis = screens[i].visibleFrame
            report("Eye panel: it goes top centre of the display that has the pointer, under the menu bar", abs(f.midX - vis.midX) < 0.5 && f.maxY <= vis.maxY && vis.maxY - f.maxY < 40 && vis.contains(f),
                   "frame=\(f) visible=\(vis) screens=\(screens.count)")
        } else {
            print("ui-check: SKIP Eye panel placement (this launch has no display)")
        }
        if let r = await render(EyeBreakView(focus: focus, face: focus.face)) {
            png("focus-11-eye-panel.png", r.rep)
            report("Eye panel: its content draws (a dark rounded panel with the countdown ring)", opaqueShare(r.rep) > 0.7 && abs(r.size.width - EyePanelPlacement.size.width) < 1, "size=\(r.size) opaque=\(opaqueShare(r.rep))")
        }
        advance(10)
        report("Eye panel: the 20-second countdown runs down", focus.eye.breakSecondsLeft(at: clock.now) == 10, "left=\(focus.eye.breakSecondsLeft(at: clock.now).map { "\($0)" } ?? "nil")")
        focus.skipBreak()
        let afterSkip = focus.dayTotal(at: clock.now)
        report("Eye: Skip closes the panel without a sound, counts as skipped and starts a new 20 minutes", !panel.isShowing && afterSkip.breaksSkipped == 1 && afterSkip.breaksTaken == 0 && focus.eye.secondsUntilBreak(at: clock.now) == 1200, "skipped=\(afterSkip.breaksSkipped) next=\(focus.eye.secondsUntilBreak(at: clock.now).map { "\($0)" } ?? "nil")")
        advance(1200)
        focus.snoozeBreak()
        report("Eye: Snooze 2 min closes the panel, brings it back in two minutes, and counts as neither", !panel.isShowing && focus.eye.secondsUntilBreak(at: clock.now) == 120 && focus.dayTotal(at: clock.now).breaksSkipped == 1, "next=\(focus.eye.secondsUntilBreak(at: clock.now).map { "\($0)" } ?? "nil")")
        advance(120)
        advance(20)
        let afterTaken = focus.dayTotal(at: clock.now)
        report("Eye: a break that runs its 20 seconds out ends with the end chime, counts as taken, and the panel says so for a moment before it goes",
               !panel.isShowing && panel.isLingering && chimes.played.last == .eyeBreakEnded && afterTaken.breaksTaken == 1, "taken=\(afterTaken.breaksTaken) lingering=\(panel.isLingering) chimes=\(chimes.played.suffix(2))")

        // 10. The away rule (F10): a locked screen or two minutes without input restarts the 20 minutes on return, and no panel shows meanwhile.
        advance(900)
        let shownBefore = panel.presentedCount
        presence.screenLocked = true; advance(5)
        advance(1500)
        let noneWhileAway = !panel.isShowing && panel.presentedCount == shownBefore
        presence.screenLocked = false; advance(1)
        report("Eye: a locked screen holds the break back, and on return the 20 minutes start over", noneWhileAway && focus.eye.secondsUntilBreak(at: clock.now) == 1200, "next=\(focus.eye.secondsUntilBreak(at: clock.now).map { "\($0)" } ?? "nil") shown=\(panel.isShowing)")
        advance(600)
        presence.idleSeconds = 130; advance(5)
        advance(2000)
        presence.idleSeconds = 1; advance(1)
        report("Eye: two minutes without input is away too, and the 20 minutes start over on return", !panel.isShowing && focus.eye.secondsUntilBreak(at: clock.now) == 1200, "next=\(focus.eye.secondsUntilBreak(at: clock.now).map { "\($0)" } ?? "nil")")
        focus.setEyeEnabled(false)
        report("Eye: switching the eye clock off stops the ticker", !focus.eyeEnabled && ticker.interval == nil, "interval=\(ticker.interval.map { "\($0)" } ?? "none")")

        // 11. The Focus menu, and the daily total in the popover.
        if let menu = NSApp.mainMenu?.items.first(where: { $0.title == "Focus" })?.submenu {
            let titles = menu.items.map(\.title)
            let wanted = ["Stop Session Early", "Add 5 Minutes", "Eye Breaks (20-20-20)", "Set Up Conn Focus…"]
            report("Focus menu: it lists the session controls, the eye switch and the setup, with no keyboard shortcut of its own", wanted.allSatisfy(titles.contains) && menu.items.allSatisfy { $0.keyEquivalent.isEmpty }, "items=\(titles.filter { !$0.isEmpty })")
        } else {
            print("ui-check: SKIP Focus menu (the menus of this launch do not list it)")
        }
        // 30 min and 2 min above, 0 min in the run that was stopped at once after its warning, and the 45-minute run that ran out: 77 minutes; one eye break taken and one skipped.
        let finalTotal = focus.dayTotal(at: clock.now)
        report("Focus: today's total is what the steps above did (77 min focused, 1 eye break taken, 1 skipped)", finalTotal.focusedSeconds == 1800 + 120 + 2700 && finalTotal.breaksTaken == 1 && finalTotal.breaksSkipped == 1, "total=\(finalTotal)")
        if let r = await render(FocusTotalCard(total: finalTotal).frame(width: 300).padding(8), opaque: true) { png("focus-12-total.png", r.rep) }

        // 12. Room in the toolbar: at the narrowest window (1000 points, `App.swift`) with the widest countdown (3:00:00), the pill must not push any toolbar item into the overflow
        // menu that the toolbar without it did not already push there.
        if let win = Capture.mainWindow(), let tb = win.toolbar {
            let savedSize = win.contentView?.frame.size ?? NSSize(width: 1500, height: 900)
            func hidden() -> [String] {
                let vis = tb.visibleItems ?? []
                return tb.items.filter { i in !vis.contains(where: { $0 === i }) }.map { $0.itemIdentifier.rawValue }
            }
            win.setContentSize(NSSize(width: 1000, height: 600)); await wait(1.2)
            let without = hidden()
            focus.start(minutes: 180); await settle(); await wait(1.0)
            let with = hidden()
            report("Focus pill: at the narrowest window (1000 pt) with the widest countdown (3:00:00) it pushes no toolbar item into the overflow menu",
                   with.count <= without.count, "items=\(tb.items.count) visible=\(tb.visibleItems?.count ?? -1) hiddenWithout=\(without) hiddenWith=\(with)")
            if let r = renderPlain(FocusPillLabel(focus: focus, face: focus.face).padding(4)) { print("ui-check: info the widest pill is \(Int(r.size.width - 8)) pt wide") }
            if let shotDir = shots { await Capture.window(to: shotDir.appendingPathComponent("focus-13-window-1000.png")) }
            focus.stopEarly(); await settle()
            win.setContentSize(savedSize); await wait(0.5)
        } else {
            print("ui-check: SKIP Focus pill toolbar room (no toolbar in this launch)")
        }

        // 13. Clean up: leave nothing behind in the test preferences or the marker folder.
        focus.setEyeEnabled(false)
        if focus.session.isActive { focus.stopEarly() }
        await settle()
        AppModel.defaults.removeObject(forKey: FocusTotalsStore.defaultKey)
        report("Focus: the Focus is off and the marker is gone at the end of the checks", focus.link == .off && !markerFile.exists && sw.calls.filter { !$0 }.count > offsAtStart && !FocusPrefs(defaults: AppModel.defaults).focusMayBeOn,
               "link=\(focus.link) marker=\(markerFile.exists) mayBeOn=\(FocusPrefs(defaults: AppModel.defaults).focusMayBeOn)")
    }
}
