// `--ui-check` step for the Reader pane's row of starred sessions. It looks at what a person sees: it draws the row of the
// real window into an image and measures it (the shapes along the row's middle line, their widths, their fill), so a
// label that is still drawn, a chip missing or a chip in the wrong place shows up. It clicks with an event built and
// delivered inside this process (like the wheel and key events elsewhere in this check), so no pointer or key event
// reaches the system. Dragging is the one thing it cannot do: a drop needs a real pointer session (README "Test notes"),
// so the reorder is checked through the model call the drop makes.
// Why pixels: SwiftUI builds no accessibility tree for an inert background window, and Vision's text reader returns
// nothing here, so neither can name the chips; the widths of the chips (each text's own width plus the chip padding)
// tell the labels apart instead.
import SwiftUI
import HelmCore

@MainActor
enum StarredBarCheck {
    /// A shape along the row's middle line, in window coordinates (origin bottom-left).
    struct Run { let rect: NSRect }

    /// The header row of the Reader pane: the 33 points above its web view.
    static func rowRect(_ reader: WebBox) -> NSRect? {
        guard reader.webView.window != nil else { return nil }
        let wf = reader.webView.convert(reader.webView.bounds, to: nil)
        return NSRect(x: wf.minX, y: wf.maxY, width: wf.width, height: 33)
    }

    /// Draw `rect` (window coordinates) of the window; the runs along its middle line that differ from the row's background,
    /// left to right (a gap of under 4 points joins two shapes, so a chip's text and a load time's digits stay one shape each).
    static func read(_ rect: NSRect, in win: NSWindow) -> (runs: [Run], image: Pixels)? {
        guard let content = win.contentView else { return nil }
        let r = content.convert(rect, from: nil)
        guard let rep = content.bitmapImageRepForCachingDisplay(in: r) else { return nil }
        content.cacheDisplay(in: r, to: rep)
        if let d = ProcessInfo.processInfo.environment["HELM_UI_CHECK_STRIP_DIR"] { Capture.writePNG(rep, to: URL(fileURLWithPath: d).appendingPathComponent("strip-\(Int(Date().timeIntervalSince1970 * 1000)).png")) }
        guard let px = Pixels(rep) else { return nil }
        let scale = CGFloat(px.width) / rect.width
        let y = px.height / 2
        let different = (0..<px.width).map { px.alpha($0, y) > 0.02 }
        var runs: [Run] = []
        var start: Int?, lastOn = -1000
        let join = Int(4 * scale)
        for x in 0..<px.width {
            if different[x] {
                if start == nil { start = x }
                lastOn = x
            } else if let s = start, x - lastOn > join {
                runs.append(Run(rect: NSRect(x: rect.minX + CGFloat(s) / scale, y: rect.minY, width: CGFloat(lastOn - s + 1) / scale, height: rect.height))); start = nil
            }
        }
        if let s = start { runs.append(Run(rect: NSRect(x: rect.minX + CGFloat(s) / scale, y: rect.minY, width: CGFloat(lastOn - s + 1) / scale, height: rect.height))) }
        return (runs, px)
    }

    /// The row's pixels as plain RGBA bytes (the cached drawing is copied through a context of our own, so the layout is known).
    struct Pixels {
        let width: Int, height: Int
        let bytes: [UInt8]
        init?(_ rep: NSBitmapImageRep) {
            guard let cg = rep.cgImage else { return nil }
            let w = cg.width, h = cg.height
            var buf = [UInt8](repeating: 0, count: w * h * 4)
            let ok = buf.withUnsafeMutableBytes { raw -> Bool in
                guard let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            guard ok else { return nil }
            width = w; height = h; bytes = buf
        }
        /// The drawing has no background of its own (the window's is not part of it), so a chip's fill is a faint alpha.
        func alpha(_ x: Int, _ y: Int) -> CGFloat {
            guard x >= 0, y >= 0, x < width, y < height else { return 0 }
            return CGFloat(bytes[(y * width + x) * 4 + 3]) / 255
        }
        /// Red, green and blue with the alpha divided out.
        func rgb(_ x: Int, _ y: Int) -> [CGFloat] {
            guard x >= 0, y >= 0, x < width, y < height else { return [0, 0, 0] }
            let o = (y * width + x) * 4
            let a = max(CGFloat(bytes[o + 3]), 1)
            return [min(1, CGFloat(bytes[o]) / a), min(1, CGFloat(bytes[o + 1]) / a), min(1, CGFloat(bytes[o + 2]) / a)]
        }
    }

    /// The width a chip with this text has: the text's own width (at most 150) and 8 points of padding on each side. A selected
    /// chip is semibold, so a measured width may sit anywhere between the two.
    static func chipWidthRange(_ text: String) -> ClosedRange<CGFloat> {
        func w(_ weight: NSFont.Weight) -> CGFloat { min(150, ceil((text as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 10.5, weight: weight)]).width)) + 16 }
        return (w(.regular) - 2.5)...(w(.semibold) + 2.5)
    }

    static func click(_ p: NSPoint, in win: NSWindow) {
        for (i, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: win.windowNumber, context: nil, eventNumber: 9000 + i, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) { win.sendEvent(e) }
        }
    }

    /// How coloured the fill just inside a chip's left end is (a selected chip is tinted with the accent colour).
    static func saturation(of chip: Run, in px: Pixels, strip: NSRect) -> CGFloat {
        let sx = CGFloat(px.width) / strip.width
        let p = px.rgb(Int((chip.rect.minX - strip.minX + 6) * sx), px.height / 2)
        return (p.max() ?? 0) - (p.min() ?? 0)
    }

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        let fixture = model.config.fixture
        model.showWeb = true; model.webTab = .reader
        // A saved order from an earlier run must not decide this one (the check runs in the test preference domain).
        model.stars.resetOrder()
        await wait(1.5)
        guard let win = Capture.mainWindow() else { report("the starred row can be inspected", false, "no main window"); return }

        // What the reader's own star list says (read the file directly, as an independent source for the expected order).
        let fileStars = (ReaderStars.read(model.stars.starsFile) ?? []).map(\.conv)
        let expected = StarOrder.arrange(stars: fileStars, saved: [])
        report("the row holds one chip per starred session, in the owner's order", !expected.isEmpty && model.stars.order == expected,
               "stars=\(fileStars.count) rows=\(model.stars.order.count) file=\(model.stars.starsFile.lastPathComponent)")
        if expected.isEmpty {
            print("ui-check: SKIP the rest of the starred row (nothing is starred in \(model.stars.starsFile.path); the empty row is checked below)")
        }

        let names = model.agentNamesBySession
        let labels = model.stars.order.map { model.stars.label(for: $0, agentNames: names) }
        let reader = model.web.box(.reader)
        guard let strip = rowRect(reader), var row = read(strip, in: win) else { report("the Reader pane's row can be read", false, "reader view is not in the window"); return }
        func describe(_ r: [Run]) -> String { r.map { String(format: "%.0f", $0.rect.width) }.joined(separator: ",") }
        // How many of the chips from the left are drawn whole and as wide as their names make them. When the row is narrower than
        // the chips it scrolls: the next chip is then cut by the edge (narrower than its name), which is the only other thing allowed.
        func wholeChips(_ r: [Run]) -> Int {
            var k = 0
            while k < min(r.count, labels.count), chipWidthRange(labels[k]).contains(r[k].rect.width) { k += 1 }
            return k
        }
        let whole = wholeChips(row.runs)
        let cutByEdge = whole < labels.count && whole < row.runs.count && row.runs[whole].rect.width < chipWidthRange(labels[whole]).lowerBound
        // One shape per chip, starting at the row's left padding, each as wide as its own name makes a chip: so the chips are the
        // starred sessions, in that order, and nothing else (a "Reader" label or a pin chip would be a shape before them).
        report("the chips are on screen, left to right in that order, each as wide as its session's name makes it", expected.isEmpty || whole == labels.count || (whole >= 1 && cutByEdge),
               "whole chips=\(whole) of \(labels.count)\(cutByEdge ? " (the row scrolls: the next one is cut by its edge)" : ""), widths on screen=[\(describe(row.runs))] expected=\(labels.map { "\($0):\(Int(chipWidthRange($0).lowerBound + 2.5))" })")
        report("the row no longer carries a \"Reader\" label: the first shape on the row is the first chip, at the row's left padding",
               row.runs.first.map { abs($0.rect.minX - strip.minX - 12) < 2.5 && chipWidthRange(labels[0]).contains($0.rect.width) } ?? expected.isEmpty,
               "first shape starts \(row.runs.first.map { String(format: "%.1f", $0.rect.minX - strip.minX) } ?? "-") points in (padding is 12) and is \(row.runs.first.map { String(format: "%.0f", $0.rect.width) } ?? "-") wide")
        let lastShape = row.runs.last
        report("the load time and the reload button are still on the row, after the chips", row.runs.count > whole + (cutByEdge ? 1 : 0) && (lastShape?.rect.maxX ?? 0) > strip.maxX - 20,
               "shapes after the chips=\(row.runs.count - whole - (cutByEdge ? 1 : 0)), the last ends \(lastShape.map { String(format: "%.0f", strip.maxX - $0.rect.maxX) } ?? "-") points from the row's right edge (padding is 12), phase=\(reader.phase)")
        if fixture, let dir = ProcessInfo.processInfo.environment["HELM_UI_CHECK_SHOT_DIR"] {
            await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("starred-row.png"))
        }

        // A click pins that session, and the chip on screen shows as selected.
        let live = Set(model.snapshot.agents.compactMap(\.sessionID))
        let target = model.stars.order.prefix(whole).first { c in live.contains(c) && !StarSelection.matches(conv: c, shown: reader.shownSession) }
        if let conv = target, let idx = model.stars.order.firstIndex(of: conv), idx < whole {
            let at = NSPoint(x: row.runs[idx].rect.midX, y: strip.midY)
            click(at, in: win)
            await wait(fixture ? 1.5 : 7)
            var n = 0; while reader.phase != .ready && n < 40 { await wait(0.25); n += 1 }
            await wait(0.5)
            let frag = reader.webView.url?.fragment ?? ""
            let onScreen = StarSelection.selected(convs: model.stars.order, shown: reader.shownSession)
            report("clicking a chip opens that session in the reader", StarSelection.matches(conv: conv, shown: StarSelection.sessionPrefix(inFragment: frag)),
                   "clicked \"\(labels[idx])\" address=#\(frag.prefix(24)) want=\(conv.prefix(8))")
            if let again = read(strip, in: win) {
                // The row may have scrolled to bring the chip into view, so the chip is found by its fill, not by its place.
                let sats = again.runs.map { saturation(of: $0, in: again.image, strip: strip) }
                let filled = sats.indices.filter { sats[$0] > 0.5 }
                let one = filled.count == 1 ? again.runs[filled[0]] : nil
                report("and that chip is the selected one: the only chip filled with the accent colour, as wide as that session's name makes it", onScreen == conv && one.map { chipWidthRange(labels[idx]).contains($0.rect.width) } == true,
                       "selected=\(onScreen.map { String($0.prefix(8)) } ?? "nil") \"\(labels[idx])\" filled shapes=\(filled.count) widths=[\(describe(again.runs))] saturation=\(sats.map { String(format: "%.2f", $0) })")
            }
            if fixture, let dir = ProcessInfo.processInfo.environment["HELM_UI_CHECK_SHOT_DIR"] {
                await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("starred-row-pinned.png"))
            }
            // Clicking the chip that is already on screen must not reload the page.
            let loads = reader.loadSeconds
            click(at, in: win); await wait(1)
            report("clicking the chip already on screen leaves the page alone", reader.phase == .ready && reader.loadSeconds == loads, "phase=\(reader.phase)")
        } else if !expected.isEmpty {
            print("ui-check: SKIP clicking a chip (none of the chips drawn whole is a session an agent runs now that is not already on screen)")
        }

        // Drag and drop: a drop calls this. The order is kept, and a fresh store over the same preferences reads it back.
        if fixture, model.stars.order.count >= 3 {
            let before = model.stars.order
            model.stars.move(before[0], onto: before[2]); await wait(0.5)
            let after = model.stars.order
            let reread = StarOrderStore(defaults: AppModel.defaults, key: "helm.readerStarOrder.fixture").order
            let want = StarOrder.moved(before, before[0], onto: before[2])
            let wantLabels = want.map { model.stars.label(for: $0, agentNames: names) }
            let shownNow = read(strip, in: win).map { Array($0.runs.prefix(wantLabels.count)) } ?? []
            let onScreenNow = shownNow.count == wantLabels.count && zip(shownNow, wantLabels).allSatisfy { chipWidthRange($1).contains($0.rect.width) }
            report("a drop reorders the chips on screen and the new order is saved for the next launch", after == want && reread == want && onScreenNow,
                   "order \(before.map { $0.suffix(3) }) -> \(after.map { $0.suffix(3) }), saved=\(reread.map { $0.suffix(3) }), widths on screen=[\(describe(shownNow))]")
            let again = StarredSessions(starsFile: model.stars.starsFile, labelsFile: model.stars.labelsFile, store: StarOrderStore(defaults: AppModel.defaults, key: "helm.readerStarOrder.fixture"))
            report("a relaunch (a new row over the same preferences) comes up in that order", again.order == want, "relaunched order=\(again.order.map { $0.suffix(3) })")
            model.stars.resetOrder()
        }

        // A star added or removed in the reader reaches a running row on its own: a row over a scratch copy of the star list.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helm-stars-check-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let scratch = dir.appendingPathComponent("stars.json")
        func write(_ convs: [String], rev: Int) {
            let list = convs.map { "{\"conv\":\"\($0)\",\"starred\":1}" }.joined(separator: ",")
            try? "{\"version\":1,\"rev\":\(rev),\"stars\":[\(list)]}\n".write(to: scratch, atomically: true, encoding: .utf8)
        }
        write(["alpha-1"], rev: 1)
        let suite = "dev.local.helm.test.starscheck"
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        defaults.removePersistentDomain(forName: suite)
        let watched = StarredSessions(starsFile: scratch, labelsFile: dir.appendingPathComponent("none.json"), store: StarOrderStore(defaults: defaults))
        watched.start(interval: 0.2)
        report("a row over an empty or one-star list starts as the file says", watched.order == ["alpha-1"], "order=\(watched.order)")
        write(["alpha-1", "beta-2"], rev: 2); await wait(1.0)
        let added = watched.order
        write(["beta-2"], rev: 3); await wait(1.0)
        let removed = watched.order
        write([], rev: 4); await wait(1.0)
        let emptied = watched.order
        write(["gamma-3"], rev: 5); await wait(1.0)
        try? "{ half".write(to: scratch, atomically: true, encoding: .utf8); await wait(1.0)
        let garbled = watched.order
        report("a star added or removed in the reader shows up in a running row without a relaunch", added == ["alpha-1", "beta-2"] && removed == ["beta-2"] && emptied.isEmpty,
               "added=\(added) removed=\(removed) emptied=\(emptied)")
        report("a half-written star list leaves the row as it was", garbled == ["gamma-3"], "row keeps=\(garbled)")
        watched.stop()
        defaults.removePersistentDomain(forName: suite)
    }
}
