// `--ui-check` steps for Conn's menu-bar item (README "The menu-bar item"): the logo as a template image of two separate linked loops, the item in each state as pixels in a
// light and a dark bar, the menu's focus line in each state, and, when the launch has the real item (`--menu-bar`, an accessory app that never takes focus), the item's own
// window growing with what it says. Runs inside `--focus-check` and `--ui-check` on the stand-ins and a hand-moved clock. `CONN_UI_CHECK_SHOT_DIR=DIR` also writes the pictures.
import SwiftUI
import AppKit
import ConnCore

@MainActor
enum MenuBarCheck {
    /// How many separate pieces of ink an image has (4-connected pixels whose alpha is above one half).
    static func inkPieces(_ rep: NSBitmapImageRep) -> Int {
        guard let px = StarredBarCheck.Pixels(rep) else { return 0 }
        let w = px.width, h = px.height
        var seen = [Bool](repeating: false, count: w * h)
        var pieces = 0
        for y in 0..<h { for x in 0..<w where !seen[y * w + x] && px.alpha(x, y) > 0.5 {
            pieces += 1
            var stack = [(x, y)]
            seen[y * w + x] = true
            while let (cx, cy) = stack.popLast() {
                for (nx, ny) in [(cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)] where nx >= 0 && ny >= 0 && nx < w && ny < h && !seen[ny * w + nx] && px.alpha(nx, ny) > 0.5 {
                    seen[ny * w + nx] = true
                    stack.append((nx, ny))
                }
            }
        } }
        return pieces
    }

    /// An image's pixels at `scale` pixels per point.
    static func bitmap(_ image: NSImage, scale: CGFloat) -> NSBitmapImageRep? {
        let size = image.size
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    /// The item drawn the way a menu bar draws a template image: in the bar's text colour on a bar of that colour. `dark` picks white on dark.
    static func strip(_ status: MenuBarStatus, dark: Bool, scale: CGFloat = 3) -> NSBitmapImageRep? {
        let item = MenuBarImage.make(status)
        let ink = dark ? NSColor.white : NSColor.black
        let tinted = NSImage(size: item.size, flipped: false) { rect in
            item.draw(in: rect)
            ink.setFill()
            rect.fill(using: .sourceIn)
            return true
        }
        let pad: CGFloat = 10
        let size = NSSize(width: item.size.width + 2 * pad, height: 24)
        let canvas = NSImage(size: size, flipped: false) { rect in
            (dark ? NSColor(red: 0.13, green: 0.15, blue: 0.19, alpha: 1) : NSColor(red: 0.86, green: 0.89, blue: 0.93, alpha: 1)).setFill()
            rect.fill()
            tinted.draw(in: NSRect(x: pad, y: (size.height - item.size.height) / 2, width: item.size.width, height: item.size.height))
            return true
        }
        return bitmap(canvas, scale: scale)
    }

    static func run(model: AppModel, focus: FocusCoordinator, clock: ManualFocusClock, switcher: ScriptedFocusSwitch, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let shots = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"].map { URL(fileURLWithPath: $0) }
        func png(_ name: String, _ rep: NSBitmapImageRep) {
            guard let d = shots, let data = rep.representation(using: .png, properties: [:]) else { return }
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            try? data.write(to: d.appendingPathComponent(name))
        }
        func advance(_ s: TimeInterval) { clock.advance(by: s); focus.tick() }

        // 1. The logo: a template image (macOS paints it in the bar's colour), 14 points tall, two loops that are separate pieces of ink (a gap between them),
        // centred in its image.
        let logo = ConnLogo.menuBarImage()
        let big = bitmap(logo, scale: 16)
        let pieces = big.map(inkPieces) ?? -1
        var centred = false
        var share = 0.0
        if let b = big, let px = StarredBarCheck.Pixels(b) {
            var minX = px.width, maxX = 0, minY = px.height, maxY = 0, n = 0
            for y in 0..<px.height { for x in 0..<px.width where px.alpha(x, y) > 0.5 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y); n += 1 } }
            centred = abs((minX + maxX) - (px.width - 1)) <= 2 && abs((minY + maxY) - (px.height - 1)) <= 2 && minY <= 1 && maxY >= px.height - 2
            share = Double(n) / Double(px.width * px.height)
        }
        report("Menu bar logo: a template image, 14 points tall, centred, made of two separate loops (a gap between them, not one blob)",
               logo.isTemplate && logo.size.height == 14 && logo.size.width > 16 && logo.size.width < 32 && pieces == 2 && centred && share > 0.25 && share < 0.60,
               "template=\(logo.isTemplate) size=\(logo.size) pieces=\(pieces) centred=\(centred) ink=\(String(format: "%.2f", share))")
        if let b = bitmap(logo, scale: 16) { png("menubar-00-logo-template-x16.png", b) }

        // 2. The item in each state, in a light and a dark bar. Widths grow with what the item says; the pictures are looked at by eye.
        let waiting = 2
        let idleStatus = MenuBarStatus.make(waiting: 0, session: FocusSession(), link: .off, now: clock.now)
        let countStatus = MenuBarStatus.make(waiting: waiting, session: FocusSession(), link: .off, now: clock.now)
        var widths: [String: CGFloat] = [:]
        func item(_ name: String, _ status: MenuBarStatus) {
            for dark in [false, true] {
                if let s = strip(status, dark: dark) {
                    if !dark { widths[name] = MenuBarImage.make(status).size.width }
                    png("menubar-\(name)-\(dark ? "dark" : "light").png", s)
                }
            }
        }
        item("01-idle", idleStatus)
        item("02-count", countStatus)
        focus.start(minutes: 25); await focus.settled(); advance(60)
        let runningStatus = MenuBarStatus.make(waiting: waiting, session: focus.session, link: focus.link, now: clock.now)
        item("03-running", runningStatus)
        let runningOnly = MenuBarStatus.make(waiting: 0, session: focus.session, link: focus.link, now: clock.now)
        item("03b-running-nothing-waiting", runningOnly)
        focus.pauseSession(); await focus.settled()
        let pausedStatus = MenuBarStatus.make(waiting: waiting, session: focus.session, link: focus.link, now: clock.now)
        item("04-paused", pausedStatus)
        focus.resumeSession(); advance(1440); await focus.settled()
        let doneStatus = MenuBarStatus.make(waiting: waiting, session: focus.session, link: focus.link, now: clock.now)
        item("05-done", doneStatus)
        focus.dismissDone()
        switcher.setResults([.failed("Error: Couldn't find shortcut 'Conn Focus On'")])
        focus.start(minutes: 25); await focus.settled(); advance(60)
        let redStatus = MenuBarStatus.make(waiting: waiting, session: focus.session, link: focus.link, now: clock.now)
        item("06-red", redStatus)
        let wIdle = widths["01-idle"] ?? 0, wCount = widths["02-count"] ?? 0, wRun = widths["03-running"] ?? 0, wRed = widths["06-red"] ?? 0
        report("Menu bar item: it grows with what it says (the logo alone, the logo and a count, then the session's time), a running time stands alone, paused and red carry a glyph (a red Conn Focus a warning triangle)",
               wIdle > 0 && wCount > wIdle && wRun > wCount && wRed > wCount && redStatus.focusSymbol == "exclamationmark.triangle.fill" && runningStatus.focusSymbol == nil && pausedStatus.focusSymbol == "pause.fill",
               "idle=\(Int(wIdle)) count=\(Int(wCount)) running=\(Int(wRun)) red=\(Int(wRed)) points; time=\(runningStatus.timeText ?? "nil") red=\(redStatus.timeText ?? "nil")")

        // 3. The menu's focus line in each state, as pictures (and its buttons by state).
        func line(_ name: String) async {
            let view = WaitingMenu(focus: focus, face: focus.face).environmentObject(model)
            if let r = await FocusCheck.render(view, opaque: true) { png("menubar-menu-\(name).png", r.rep) }
        }
        let redLine = MenuFocusLine.make(session: focus.session, link: focus.link, now: clock.now)
        await line("06-red")
        switcher.setResults([.done])
        focus.retryFocus(); await focus.settled()
        let runLine = MenuFocusLine.make(session: focus.session, link: focus.link, now: clock.now)
        await line("03-running")
        focus.pauseSession(); await focus.settled()
        await line("04-paused")
        focus.resumeSession()
        advance(1500); await focus.settled()
        await line("05-done")
        focus.dismissDone()
        await line("01-idle")
        report("Menu bar menu: the focus line leads with the session in words (time left and end time while running), offers Try again only in red, and Pause or Resume, +5 min, Restart by state",
               runLine.title.hasPrefix("Focus ") && runLine.title.hasSuffix(" left") && runLine.detail.hasPrefix("25 min · ends ") && runLine.actions == [.pause, .extend, .openControls]
                && redLine.warning != nil && redLine.actions.first == .retry && runLine.warning == nil,
               "run=\(runLine.title) / \(runLine.detail) red=\(redLine.warning ?? "nil")")
        if focus.session.isActive { focus.stopEarly(); await focus.settled() }
        focus.dismissDone()

        // 4. The real item, when this launch has it (`--menu-bar`): the status button holds one image and no title (a SwiftUI label keeps only the first image and the first
        // text), and that image grows with what the item says. (The window and its button are the app's own; nothing of the screen is read.)
        let windows = NSApp.windows.filter { $0.className.contains("StatusBar") }
        guard let w = windows.first else {
            print("ui-check: SKIP Menu bar item (this launch has no menu-bar item: add --menu-bar)")
            return
        }
        func button(_ v: NSView) -> NSStatusBarButton? { (v as? NSStatusBarButton) ?? v.subviews.lazy.compactMap(button).first }
        func real() async -> (width: CGFloat, title: String, image: NSImage?, frame: CGFloat) {
            await wait(1.2)
            let b = w.contentView.flatMap(button)
            return (b?.image?.size.width ?? 0, b?.title ?? "?", b?.image, w.frame.width)
        }
        func look(_ name: String, _ image: NSImage?) {
            guard let image else { return }
            let tinted = NSImage(size: image.size, flipped: false) { rect in image.draw(in: rect); NSColor.black.setFill(); rect.fill(using: .sourceIn); return true }
            if let rep = bitmap(tinted, scale: 3) { png(name, rep) }
        }
        switcher.setResults([.done])
        let rIdle = await real()
        focus.start(minutes: 25); await focus.settled(); advance(60)
        let rRun = await real()
        look("menubar-real-running.png", rRun.image)
        focus.pauseSession(); await focus.settled()
        let rPaused = await real()
        focus.resumeSession(); focus.stopEarly(); await focus.settled()
        switcher.setResults([.failed("Error: Couldn't find shortcut 'Conn Focus On'")])
        focus.start(minutes: 25); await focus.settled(); advance(60)
        let rRed = await real()
        look("menubar-real-red.png", rRed.image)
        switcher.setResults([.done])
        focus.stopEarly(); await focus.settled()
        let rAfter = await real()
        look("menubar-real-idle.png", rAfter.image)
        let expectedRun = MenuBarImage.make(MenuBarStatus.make(waiting: model.waiting.count, session: { var s = FocusSession(); s.start(minutes: 25, now: clock.now); return s }(), link: .onConfirmed, now: clock.now)).size.width
        report("Menu bar item (the real one): one item whose status button holds the whole picture (no separate title), as wide as what it says: wider with a session's time, a pause or a red mark, and back to its first width when it ends",
               windows.count == 1 && [rIdle, rRun, rPaused, rRed, rAfter].allSatisfy { $0.title.isEmpty } && rRun.width > rIdle.width && rPaused.width > rIdle.width && rRed.width > rIdle.width
                && abs(rAfter.width - rIdle.width) < 1 && abs(rRun.width - expectedRun) < 2,
               "items=\(windows.count) idle=\(Int(rIdle.width)) running=\(Int(rRun.width)) (expected \(Int(expectedRun))) paused=\(Int(rPaused.width)) red=\(Int(rRed.width)) after=\(Int(rAfter.width)) window=\(Int(rRun.frame)) titles=\([rIdle.title, rRun.title, rPaused.title, rRed.title, rAfter.title])")
    }
}
