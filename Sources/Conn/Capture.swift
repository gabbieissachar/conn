// Window capture. screencapture is not permitted for this process, so the app renders
// itself: AppKit views through cacheDisplay, web views through WKWebView.takeSnapshot, composited into one PNG.
// Used with --tour on fixture data only, so no private conversation can reach an image.
import SwiftUI
import WebKit
import CoreImage

@MainActor
enum Capture {
    static func mainWindow() -> NSWindow? {
        NSApp.windows.first { $0.isVisible && $0.styleMask.contains(.titled) && $0.contentView != nil }
    }

    private static func webViews(in view: NSView) -> [WKWebView] {
        var out: [WKWebView] = []
        if let w = view as? WKWebView { out.append(w) }
        for s in view.subviews { out += webViews(in: s) }
        return out
    }

    private static func snapshot(of web: WKWebView) async -> NSImage? {
        await withCheckedContinuation { cont in
            web.takeSnapshot(with: nil) { image, _ in cont.resume(returning: image) }
        }
    }

    static func writePNG(_ rep: NSBitmapImageRep, to url: URL) {
        if let data = rep.representation(using: .png, properties: [:]) { try? data.write(to: url) }
    }

    /// Whole window, title bar included, at 2x.
    static func window(to url: URL) async {
        guard let window = mainWindow(), let frameView = window.contentView?.superview ?? window.contentView else {
            let d = NSApp.windows.map { "\($0.className) title='\($0.title)' visible=\($0.isVisible) titled=\($0.styleMask.contains(.titled)) frame=\($0.frame)" }
            FileHandle.standardError.write("capture: no main window; windows=\(d)\n".data(using: .utf8)!)
            return
        }
        let size = frameView.bounds.size
        guard let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) else { return }
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        var overlays: [(NSImage, NSRect)] = []
        for wv in webViews(in: frameView) where !wv.isHiddenOrHasHiddenAncestor && wv.window != nil {
            if let img = await snapshot(of: wv) { overlays.append((img, wv.convert(wv.bounds, to: nil))) }
        }
        let scale: CGFloat = 2
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        out.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        let base = NSImage(size: size); base.addRepresentation(rep)
        base.draw(in: NSRect(origin: .zero, size: size))
        for (img, rect) in overlays { img.draw(in: rect) }
        NSGraphicsContext.restoreGraphicsState()
        writePNG(out, to: url)
    }

    /// Any SwiftUI view to a PNG (used for the menu bar popover, which a window capture cannot see).
    static func render<V: View>(_ view: V, scale: CGFloat = 2, to url: URL) {
        let r = ImageRenderer(content: view)
        r.scale = scale
        if let cg = r.cgImage { writePNG(NSBitmapImageRep(cgImage: cg), to: url) }
    }
}

@MainActor
enum Tour {
    /// A short scripted tour for screenshots: agent view, editor, Herdr's screen. Run it against the stand-in session
    /// (./run.sh --fixture --tour DIR) so no private conversation reaches an image.
    static func run(dir: URL, model: AppModel) async {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        func wait(_ s: Double) async { try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        func shot(_ name: String) async {
            FileHandle.standardError.write("tour step \(name)\n".data(using: .utf8)!)
            await Capture.window(to: dir.appendingPathComponent(name + ".png"))
        }
        model.agentViewEnabled = true      // the tour shows the Agent view, which is off unless asked for
        model.appearance = .light
        await wait(4); await shot("01-agent")
        model.toggleCompare()
        await wait(3); await shot("02-compare")
        model.toggleCompare()
        model.showSwitcher = true; model.switcherQuery = "agent 1"
        await wait(1.2); await shot("03-switcher")
        model.showSwitcher = false; model.switcherQuery = ""
        model.mode = .editor
        let sample = dir.appendingPathComponent("notes.md")
        try? "# Sample note\n\nConn edits plain text and markdown.\n\n- save with Cmd+S\n- the file on disk is checked before every save\n".write(to: sample, atomically: true, encoding: .utf8)
        model.editor.open(sample)
        await wait(1.5); await shot("04-editor")
        model.mode = .herdr
        await wait(1); await shot("05-herdr-screen")
        model.mode = .agent
        model.appearance = .dark
        await wait(2.5); await shot("06-dark")
        model.privacy = true
        await wait(1); await shot("07-privacy")
        print("tour done: \(dir.path)")
    }
}
