// Conn's one menu-bar item: its logo as a template image, the waiting count, and the focus session's time; and the menu it opens (a focus line, then who is waiting).
import SwiftUI
import AppKit
import ConnCore

// MARK: the logo

/// The app icon's two linked loops (`tools/make_icon.swift`, "linked-loops": a pair of mirror-tilted pill outlines) as a one-colour shape, drawn in code so it is sharp at every
/// scale. It is a template image: macOS paints it in the menu bar's own colour, so it reads on a light bar, a dark bar and over a tinted wallpaper.
/// The icon's own proportions (pills 0.54 x 0.30, stroke 0.12, centres 0.22 apart) fill up into a blob at this size, so this is the same pair drawn for a small mono glyph:
/// pills 0.50 x 0.30, a thinner stroke (0.09), centres 0.44 apart, tilted 0.45 rad either way. The right loop lies over the left one with a gap around it, which leaves two
/// separate pieces of ink and no slivers (an over-and-under weave was tried: at this size it leaves fragments inside the right loop's hole).
enum ConnLogo {
    private static let tilt: CGFloat = 0.45
    private static let stroke: CGFloat = 0.09
    private static let gap: CGFloat = 0.045
    private static let centres: (left: CGFloat, right: CGFloat) = (0.28, 0.72)

    /// The menu-bar image: `height` points tall, as wide as the logo is.
    static func menuBarImage(height: CGFloat = 14) -> NSImage {
        let ink = inkBounds
        let scale = height / ink.height
        let size = NSSize(width: (ink.width * scale).rounded(.up), height: height)
        let image = NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            // Unit square (y up) -> the image, with the ink centred.
            ctx.translateBy(x: rect.midX - ink.midX * scale, y: rect.midY - ink.midY * scale)
            ctx.scaleBy(x: scale, y: scale)
            draw(in: ctx)
            ctx.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Conn"
        return image
    }

    /// Where the loops put ink, in the unit square (y up): both pills at their tilt, plus half the stroke.
    static var inkBounds: CGRect {
        loops.reduce(CGRect.null) { $0.union($1.copy(strokingWithWidth: stroke, lineCap: .round, lineJoin: .round, miterLimit: 10).boundingBoxOfPath) }
    }

    private static var loops: [CGPath] { [loopPath(centres.left, -tilt), loopPath(centres.right, tilt)] }

    private static func loopPath(_ cx: CGFloat, _ angle: CGFloat) -> CGPath {
        let t = CGAffineTransform(translationX: cx, y: 0.5).rotated(by: angle)
        return CGPath(roundedRect: CGRect(x: -0.25, y: -0.15, width: 0.50, height: 0.30), cornerWidth: 0.15, cornerHeight: 0.15, transform: [t])
    }

    private static func draw(in ctx: CGContext) {
        let (left, right) = (loops[0], loops[1])
        ctx.setLineWidth(stroke); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        ctx.setStrokeColor(CGColor(gray: 0, alpha: 1))
        ctx.addPath(left); ctx.strokePath()
        // A gap around the right loop (clear, not white: the image stays a template), then the loop itself.
        ctx.saveGState()
        ctx.setBlendMode(.clear)
        ctx.setLineWidth(stroke + 2 * gap)
        ctx.addPath(right); ctx.strokePath()
        ctx.restoreGState()
        ctx.addPath(right); ctx.strokePath()
    }
}

// MARK: the item

/// The label of the menu-bar item: one template image (`MenuBarImage`). A SwiftUI `MenuBarExtra` label is flattened into the status button's one image and one title, so a
/// label of several texts and symbols loses all but the first (the fixture run showed the button holding the logo and the count only, whatever the session did); a label
/// that is a single image carries everything, and as a template image macOS tints it for the bar.
struct MenuBarLabel: View {
    @ObservedObject var app: AppModel
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace

    var body: some View {
        let status = MenuBarStatus.make(waiting: app.waiting.count, session: focus.session, link: focus.link, now: face.now)
        Image(nsImage: MenuBarImage.make(status))
    }
}

/// What the item shows, drawn as one template image: the logo, then (when something waits) the count, then (while a session exists) its glyph and time. Text is the menu
/// bar's own size and weight with fixed-width digits, so the item does not jiggle as the countdown ticks.
enum MenuBarImage {
    static let height: CGFloat = 22
    static let logoHeight: CGFloat = 14
    private static let gap: CGFloat = 5
    private static let glyphGap: CGFloat = 3
    /// Wider than `gap`, so a count and a time side by side (`2  24:13`) do not read as one number.
    private static let groupGap: CGFloat = 10

    private static var font: NSFont { NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular) }

    private static func symbol(_ name: String) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return nil }
        // A symbol drawn straight into another image takes its colour from the context, so paint it black: only its shape matters to a template.
        let size = base.size
        return NSImage(size: size, flipped: false) { rect in
            base.draw(in: rect)
            NSColor.black.setFill()
            rect.fill(using: .sourceAtop)
            return true
        }
    }

    static func make(_ status: MenuBarStatus) -> NSImage {
        let logo = ConnLogo.menuBarImage(height: logoHeight)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
        let count = status.countText.map { NSAttributedString(string: $0, attributes: attributes) }
        let glyph = status.focusSymbol.flatMap(symbol)
        let time = status.timeText.map { NSAttributedString(string: $0, attributes: attributes) }
        var width = logo.size.width
        if let count { width += gap + ceil(count.size().width) }
        if glyph != nil || time != nil {
            width += (count == nil ? gap : groupGap)
            if let glyph { width += glyph.size.width + (time == nil ? 0 : glyphGap) }
            if let time { width += ceil(time.size().width) }
        }
        let image = NSImage(size: NSSize(width: ceil(width), height: height), flipped: false) { rect in
            var x: CGFloat = 0
            logo.draw(in: NSRect(x: x, y: (rect.height - logo.size.height) / 2, width: logo.size.width, height: logo.size.height))
            x += logo.size.width
            func text(_ t: NSAttributedString) {
                let h = t.size().height
                t.draw(at: NSPoint(x: x, y: (rect.height - h) / 2))
                x += ceil(t.size().width)
            }
            if let count { x += gap; text(count) }
            if glyph != nil || time != nil {
                x += (count == nil ? gap : groupGap)
                if let glyph {
                    glyph.draw(in: NSRect(x: x, y: (rect.height - glyph.size.height) / 2, width: glyph.size.width, height: glyph.size.height))
                    x += glyph.size.width + (time == nil ? 0 : glyphGap)
                }
                if let time { text(time) }
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = status.accessibilityText
        return image
    }
}

// MARK: the menu

struct WaitingMenu: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MenuFocusSection(focus: focus, face: face)
            Divider().padding(.vertical, 4)
            let w = app.waiting
            Text(w.isEmpty ? "Nothing is waiting on you" : "Waiting on you (\(w.count))").font(.system(size: 13, weight: .semibold)).padding(.bottom, 2)
            ForEach(w) { a in
                Button {
                    app.select(a.id)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                } label: {
                    HStack(spacing: 8) {
                        StateGlyph(state: a.state)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                            Text("\(app.snapshot.workspace(a.workspaceID)?.label ?? "") · \(a.state.label)").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Divider().padding(.vertical, 4)
            Button("Open Conn") { NSApplication.shared.activate(ignoringOtherApps: true) }.buttonStyle(.plain)
            Button("Quit Conn") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain)
        }
        .padding(12).frame(width: 300, alignment: .leading)
    }
}

/// The focus line: what the session is doing, a red sentence when Conn Focus is not on, and the buttons for this state. It watches the focus ticker while the menu is open.
struct MenuFocusSection: View {
    @ObservedObject var focus: FocusCoordinator
    @ObservedObject var face: FocusFace
    @EnvironmentObject var app: AppModel

    var body: some View {
        let line = MenuFocusLine.make(session: focus.session, link: focus.link, now: face.now)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: icon).foregroundStyle(line.warning != nil ? Color(nsColor: .systemRed) : FocusStyle.focus).font(.system(size: 12, weight: .semibold))
                Text(line.title).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                Spacer(minLength: 0)
            }
            Text(line.detail).font(.system(size: 11)).foregroundStyle(.secondary).padding(.leading, 18)
            if let w = line.warning {
                Text("\(w). Other apps' banners may not be silenced.").font(.system(size: 11)).foregroundStyle(Color(nsColor: .systemRed))
                    .fixedSize(horizontal: false, vertical: true).padding(.leading, 18)
            }
            HStack(spacing: 6) {
                ForEach(line.actions, id: \.self) { a in
                    Button(label(a)) { perform(a) }.buttonStyle(.bordered).controlSize(.small)
                }
            }
            .padding(.leading, 18)
        }
        .onAppear { focus.beginWatching() }
        .onDisappear { focus.endWatching() }
    }

    private var icon: String {
        if focus.link.isRed { return "exclamationmark.triangle.fill" }
        switch focus.session.phase {
        case .idle: return "timer"
        case .running: return "timer"
        case .paused: return "pause.fill"
        case .done: return "checkmark.circle.fill"
        }
    }

    private func label(_ a: MenuFocusLine.Action) -> String {
        switch a {
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .extend: return "+5 min"
        case .restart: return "Restart"
        case .retry: return "Try again"
        case .openControls: return focus.session.isIdle ? "Start…" : "More…"
        }
    }

    private func perform(_ a: MenuFocusLine.Action) {
        switch a {
        case .pause: focus.pauseSession()
        case .resume: focus.resumeSession()
        case .extend: focus.extendSession()
        case .restart: focus.restart()
        case .retry: if case .couldNotSwitchOff = focus.link { focus.retrySwitchOff() } else { focus.retryFocus() }
        case .openControls:
            app.focusPopoverShown = true
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }
}
