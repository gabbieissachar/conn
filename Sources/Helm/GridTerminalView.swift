// GridTerminalNSView: draws a VTScreen with CoreText-backed AppKit text drawing, one cell grid, no web view.
// This is the "hot path is a native view" rule from the best-practices report, section 3 rule 2.
// Block and box-drawing characters are painted as rectangles so Claude Code's logo and separators join up
// exactly instead of showing the gaps a font glyph leaves between rows.
import AppKit
import SwiftUI
import HelmCore
import HelmTerminal

typealias Theme = TerminalTheme

final class GridTerminalNSView: NSView {
    var screen: VTScreen? { didSet { needsDisplay = true } }
    var theme: Theme = .light { didSet { colorCache.removeAll(); needsDisplay = true } }
    /// Privacy mode: text is drawn as solid bars (box and block characters stay), so nothing readable reaches a screen share.
    var redact = false { didSet { if redact != oldValue { needsDisplay = true } } }

    private let padX: CGFloat = 10
    private let padY: CGFloat = 8
    private(set) var cellW: CGFloat = 7
    private(set) var cellH: CGFloat = 15
    private var fonts: [NSFont] = []          // regular, bold, italic, bold-italic
    private var colorCache: [UInt32: NSColor] = [:]
    private var selStart: (row: Int, col: Int)?
    private var selEnd: (row: Int, col: Int)?
    private var fontSize: CGFloat = 12
    private var lastGrid = (0, 0)
    /// First pane row that is drawn. A pane taller than the view is shown from the bottom (where the live prompt is).
    private(set) var topRow = 0

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }

    override init(frame: NSRect) { super.init(frame: frame); setup(size: 12); wantsLayer = true }
    required init?(coder: NSCoder) { super.init(coder: coder); setup(size: 12); wantsLayer = true }

    private func setup(size: CGFloat) {
        fontSize = size
        let base = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        let bold = NSFont.monospacedSystemFont(ofSize: size, weight: .semibold)
        let fm = NSFontManager.shared
        let italic = fm.convert(base, toHaveTrait: .italicFontMask)
        let boldItalic = fm.convert(bold, toHaveTrait: .italicFontMask)
        fonts = [base, bold, italic, boldItalic]
        cellW = ("M" as NSString).size(withAttributes: [.font: base]).width
        cellH = ceil(base.ascender - base.descender + base.leading) + 1
    }

    /// Pick the font so every column is visible (between 8 and 12.5 pt); a pane taller than the view loses its top rows.
    private func refit() {
        guard let s = screen else { return }
        let availW = bounds.width - 2 * padX, availH = bounds.height - 2 * padY
        guard availW > 60, availH > 60 else { return }
        var size: CGFloat = 12.5
        while size > 8 {
            let f = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
            let w = ("M" as NSString).size(withAttributes: [.font: f]).width
            if w * CGFloat(s.cols) <= availW { break }
            size -= 0.5
        }
        if abs(size - fontSize) > 0.01 { setup(size: size); needsDisplay = true }
        let visible = max(1, Int(availH / cellH))
        let top = max(0, s.rows - visible)
        if top != topRow { topRow = top; needsDisplay = true }
    }

    // MARK: geometry

    override func layout() {
        super.layout()
        refit()
    }

    func screenChanged() {
        guard let screen = screen else { return }
        if (screen.cols, screen.rows) != lastGrid { lastGrid = (screen.cols, screen.rows); refit(); needsDisplay = true }
        for r in screen.takeDirtyRows() where r >= topRow {
            setNeedsDisplay(NSRect(x: 0, y: padY + CGFloat(r - topRow) * cellH - 1, width: bounds.width, height: cellH + 2))
        }
    }

    // MARK: colour

    private func resolve(_ c: UInt32, fallback: NSColor) -> NSColor {
        if c == 0 { return fallback }
        if let cached = colorCache[c] { return cached }
        let color: NSColor
        switch c >> 24 {
        case 1:
            let i = Int(c & 0xff)
            if i < 16 { color = theme.ansi[i] }
            else if i < 232 {
                let n = i - 16, lv: [CGFloat] = [0, 95, 135, 175, 215, 255]
                color = NSColor(srgbRed: lv[n / 36] / 255, green: lv[(n / 6) % 6] / 255, blue: lv[n % 6] / 255, alpha: 1)
            } else {
                let g = CGFloat(8 + 10 * (i - 232)) / 255
                color = NSColor(srgbRed: g, green: g, blue: g, alpha: 1)
            }
        default:
            color = NSColor(srgbRed: CGFloat((c >> 16) & 0xff) / 255, green: CGFloat((c >> 8) & 0xff) / 255, blue: CGFloat(c & 0xff) / 255, alpha: 1)
        }
        colorCache[c] = color
        return color
    }

    private func colors(for cell: Cell) -> (fg: NSColor, bg: NSColor, hasBG: Bool) {
        var fg = resolve(cell.fg, fallback: theme.fg)
        var bg = resolve(cell.bg, fallback: theme.bg)
        var hasBG = cell.bg != 0
        if cell.attrs & Attr.inverse != 0 { swap(&fg, &bg); hasBG = true }
        if cell.attrs & Attr.dim != 0 { fg = fg.blended(withFraction: 0.45, of: bg) ?? fg }
        return (fg, bg, hasBG)
    }

    // MARK: drawing

    override func draw(_ dirtyRect: NSRect) {
        // cacheDisplay passes an effectively infinite dirty rect and does not clip subviews, so clip to our own bounds.
        NSBezierPath(rect: bounds).setClip()
        theme.bg.setFill()
        dirtyRect.intersection(bounds).fill()
        guard let screen = screen else { return }
        // cacheDisplay can hand us an effectively infinite rect, so clamp in floating point before converting.
        let top = max(0, (dirtyRect.minY - padY) / cellH)
        let bottom = min(Double(screen.rows - 1), Double((dirtyRect.maxY - padY) / cellH))
        guard bottom >= 0, top <= Double(screen.rows - 1) else { return }
        let r0 = Int(top.rounded(.down)) + topRow, r1 = min(screen.rows - 1, Int(bottom.rounded(.down)) + topRow)
        guard r0 <= r1 else { return }
        for r in r0...r1 { drawRow(r, screen) }
    }

    private func bgKey(_ cell: Cell) -> UInt64 {
        cell.attrs & Attr.inverse != 0 ? (1 << 40) | UInt64(cell.fg) : UInt64(cell.bg)
    }

    private func isSelected(_ r: Int, _ c: Int) -> Bool {
        guard let a = selStart, let b = selEnd else { return false }
        let (s, e) = (a.row, a.col) <= (b.row, b.col) ? (a, b) : (b, a)
        if r < s.row || r > e.row { return false }
        if r == s.row && c < s.col { return false }
        if r == e.row && c > e.col { return false }
        return true
    }

    private func drawRow(_ r: Int, _ screen: VTScreen) {
        let y = padY + CGFloat(r - topRow) * cellH
        let cols = screen.cols
        // Pass 1: backgrounds and selection.
        var c = 0
        while c < cols {
            let cell = screen.cell(r, c)
            let (_, bg, has) = colors(for: cell)
            var end = c + 1
            let key = bgKey(cell)
            while end < cols, bgKey(screen.cell(r, end)) == key { end += 1 }
            if has {
                bg.setFill()
                NSRect(x: padX + CGFloat(c) * cellW, y: y, width: CGFloat(end - c) * cellW, height: cellH).fill()
            }
            c = end
        }
        if selStart != nil {
            theme.selection.setFill()
            for cc in 0..<cols where isSelected(r, cc) {
                NSRect(x: padX + CGFloat(cc) * cellW, y: y, width: cellW, height: cellH).fill()
            }
        }
        // Pass 2: glyphs.
        c = 0
        while c < cols {
            if redact {
                let cell = screen.cell(r, c)
                if cell.ch != 32 && cell.ch != 0 && !isBoxOrBlock(cell.ch) {
                    var end = c + 1
                    while end < cols, screen.cell(r, end).ch != 32, !isBoxOrBlock(screen.cell(r, end).ch) { end += 1 }
                    colors(for: cell).fg.withAlphaComponent(0.22).setFill()
                    NSBezierPath(roundedRect: NSRect(x: padX + CGFloat(c) * cellW + 0.5, y: y + cellH * 0.22, width: CGFloat(end - c) * cellW - 1, height: cellH * 0.56), xRadius: 3, yRadius: 3).fill()
                    c = end; continue
                }
            }
            let cell = screen.cell(r, c)
            let x = padX + CGFloat(c) * cellW
            if cell.ch == 0 { c += 1; continue }
            if cell.ch == 32 && cell.attrs & (Attr.underline | Attr.strike) == 0 { c += 1; continue }
            if cell.attrs & Attr.hidden != 0 { c += 1; continue }
            let (fg, _, _) = colors(for: cell)
            if drawBlockOrBox(cell.ch, x: x, y: y, color: fg) { c += 1; continue }
            if cell.ch >= 0x20 && cell.ch < 0x7f {
                var s = String(UnicodeScalar(cell.ch)!)
                var end = c + 1
                while end < cols {
                    let n = screen.cell(r, end)
                    if n.ch >= 0x20 && n.ch < 0x7f, n.fg == cell.fg, n.bg == cell.bg, n.attrs == cell.attrs { s.unicodeScalars.append(UnicodeScalar(n.ch)!); end += 1 } else { break }
                }
                drawText(s, x: x, y: y, cell: cell, color: fg)
                c = end
            } else {
                if let u = UnicodeScalar(cell.ch) { drawText(String(u), x: x, y: y, cell: cell, color: fg) }
                c += (cell.attrs & Attr.wide != 0) ? 2 : 1
            }
        }
    }

    private func isBoxOrBlock(_ ch: UInt32) -> Bool { (0x2500...0x259F).contains(ch) }

    private func drawText(_ s: String, x: CGFloat, y: CGFloat, cell: Cell, color: NSColor) {
        let idx = (cell.attrs & Attr.bold != 0 ? 1 : 0) + (cell.attrs & Attr.italic != 0 ? 2 : 0)
        var attrs: [NSAttributedString.Key: Any] = [.font: fonts[idx], .foregroundColor: color]
        if cell.attrs & Attr.underline != 0 { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        if cell.attrs & Attr.strike != 0 { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        (s as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: attrs)
    }

    // Block elements and light box lines, painted as exact rectangles.
    private func drawBlockOrBox(_ ch: UInt32, x: CGFloat, y: CGFloat, color: NSColor) -> Bool {
        let w = cellW, h = cellH
        func fillRect(_ rx: CGFloat, _ ry: CGFloat, _ rw: CGFloat, _ rh: CGFloat, alpha: CGFloat = 1) {
            color.withAlphaComponent(alpha).setFill()
            NSRect(x: x + rx, y: y + ry, width: rw, height: rh).fill()
        }
        switch ch {
        case 0x2580: fillRect(0, 0, w, h / 2); return true
        case 0x2581...0x2588: let f = CGFloat(ch - 0x2580) / 8; fillRect(0, h * (1 - f), w, h * f); return true
        case 0x2589...0x258F: let f = CGFloat(0x2590 - ch) / 8; fillRect(0, 0, w * f, h); return true
        case 0x2590: fillRect(w / 2, 0, w / 2, h); return true
        case 0x2591: fillRect(0, 0, w, h, alpha: 0.25); return true
        case 0x2592: fillRect(0, 0, w, h, alpha: 0.5); return true
        case 0x2593: fillRect(0, 0, w, h, alpha: 0.75); return true
        case 0x2594: fillRect(0, 0, w, h / 8); return true
        case 0x2595: fillRect(w * 7 / 8, 0, w / 8, h); return true
        case 0x2596...0x259F:
            // bits: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right
            let masks: [UInt32: Int] = [0x2596: 4, 0x2597: 8, 0x2598: 1, 0x2599: 1 | 4 | 8, 0x259A: 1 | 8,
                                        0x259B: 1 | 2 | 4, 0x259C: 1 | 2 | 8, 0x259D: 2, 0x259E: 2 | 4, 0x259F: 2 | 4 | 8]
            let m = masks[ch] ?? 0
            if m & 1 != 0 { fillRect(0, 0, w / 2, h / 2) }
            if m & 2 != 0 { fillRect(w / 2, 0, w / 2, h / 2) }
            if m & 4 != 0 { fillRect(0, h / 2, w / 2, h / 2) }
            if m & 8 != 0 { fillRect(w / 2, h / 2, w / 2, h / 2) }
            return true
        default: break
        }
        guard let seg = boxSegments(ch) else { return false }
        let light = max(1, (h / 14).rounded()), heavy = light * 2
        let cx = (w / 2).rounded(), cy = (h / 2).rounded()
        func t(_ v: Int) -> CGFloat { v == 2 ? heavy : light }
        if seg.l > 0 { fillRect(0, cy - t(seg.l) / 2, cx + t(max(seg.u, seg.d)) / 2, t(seg.l)) }
        if seg.r > 0 { fillRect(cx - t(max(seg.u, seg.d)) / 2, cy - t(seg.r) / 2, w - cx + t(max(seg.u, seg.d)) / 2, t(seg.r)) }
        if seg.u > 0 { fillRect(cx - t(seg.u) / 2, 0, t(seg.u), cy + t(max(seg.l, seg.r)) / 2) }
        if seg.d > 0 { fillRect(cx - t(seg.d) / 2, cy - t(max(seg.l, seg.r)) / 2, t(seg.d), h - cy + t(max(seg.l, seg.r)) / 2) }
        return true
    }

    private func boxSegments(_ ch: UInt32) -> (l: Int, r: Int, u: Int, d: Int)? {
        switch ch {
        case 0x2500, 0x2504, 0x2508, 0x254C, 0x2574...0x2576: return (1, 1, 0, 0)
        case 0x2501, 0x2505, 0x2509, 0x254D, 0x2550: return (2, 2, 0, 0)
        case 0x2502, 0x2506, 0x250A, 0x254E: return (0, 0, 1, 1)
        case 0x2503, 0x2507, 0x250B, 0x254F, 0x2551: return (0, 0, 2, 2)
        case 0x250C, 0x256D: return (0, 1, 0, 1)
        case 0x2510, 0x256E: return (1, 0, 0, 1)
        case 0x2514, 0x2570: return (0, 1, 1, 0)
        case 0x2518, 0x256F: return (1, 0, 1, 0)
        case 0x251C: return (0, 1, 1, 1)
        case 0x2524: return (1, 0, 1, 1)
        case 0x252C: return (1, 1, 0, 1)
        case 0x2534: return (1, 1, 1, 0)
        case 0x253C: return (1, 1, 1, 1)
        default: return nil
        }
    }

    // MARK: selection and copy (read-only pane: copying is the one thing you can do with the text)

    private func cellAt(_ p: NSPoint) -> (row: Int, col: Int)? {
        guard let s = screen else { return nil }
        let r = Int(max(-1, min(10_000, (p.y - padY) / cellH))) + topRow, c = Int(max(-1, min(10_000, (p.x - padX) / cellW)))
        return (min(max(0, r), s.rows - 1), min(max(0, c), s.cols - 1))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        selStart = cellAt(convert(event.locationInWindow, from: nil)); selEnd = selStart
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        selEnd = cellAt(convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if let a = selStart, let b = selEnd, a.row == b.row, a.col == b.col { selStart = nil; selEnd = nil; needsDisplay = true }
    }

    @objc func copy(_ sender: Any?) {
        guard let s = screen, let a = selStart, let b = selEnd else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s.text(from: a, to: b), forType: .string)
    }

    func clearSelection() { selStart = nil; selEnd = nil; needsDisplay = true }
}

