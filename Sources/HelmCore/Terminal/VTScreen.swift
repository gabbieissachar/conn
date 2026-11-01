// VTScreen: a small terminal-state model fed by the ANSI bytes of a Herdr `terminal.frame`.
//
// Herdr renders each pane on the server (ghostty-vt) at the observer's geometry and streams the result as ANSI.
// The frames recorded for this prototype use only: CUP, SGR (16/256/truecolor), ED 2, DECSET 2026 (synchronized
// output) and 25 (cursor), and OSC 8 (hyperlinks). This model handles those plus the common cursor, erase and
// scroll controls so a plain shell pane would also draw. Unknown sequences are counted, never fatal.
import Foundation

public struct Cell: Equatable {
    public var ch: UInt32 = 32      // Unicode scalar; 0 marks the right half of a wide character
    public var fg: UInt32 = 0       // 0 default, 0x01_0000nn palette index, 0x02_rrggbb truecolor
    public var bg: UInt32 = 0
    public var attrs: UInt16 = 0
    public init(ch: UInt32 = 32, fg: UInt32 = 0, bg: UInt32 = 0, attrs: UInt16 = 0) { self.ch = ch; self.fg = fg; self.bg = bg; self.attrs = attrs }
}

public enum Attr {
    public static let bold: UInt16 = 1
    public static let dim: UInt16 = 2
    public static let italic: UInt16 = 4
    public static let underline: UInt16 = 8
    public static let inverse: UInt16 = 16
    public static let strike: UInt16 = 32
    public static let hidden: UInt16 = 64
    public static let wide: UInt16 = 128
}

@inline(__always) public func paletteColor(_ i: Int) -> UInt32 { 0x0100_0000 | UInt32(i & 0xff) }
@inline(__always) public func rgbColor(_ r: Int, _ g: Int, _ b: Int) -> UInt32 {
    0x0200_0000 | (UInt32(r & 0xff) << 16) | (UInt32(g & 0xff) << 8) | UInt32(b & 0xff)
}

public func cellWidth(_ c: UInt32) -> Int {
    if c < 0x300 { return 1 }
    if (0x300...0x36F).contains(c) || (0x200B...0x200F).contains(c) || (0xFE00...0xFE0F).contains(c) { return 0 }
    switch c {
    case 0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA000...0xA4CF,
         0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE6F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
         0x1F300...0x1F64F, 0x1F900...0x1F9FF, 0x20000...0x3FFFD:
        return 2
    default:
        return 1
    }
}

public final class VTScreen {
    public private(set) var cols: Int
    public private(set) var rows: Int
    public private(set) var cells: [Cell]
    public private(set) var dirtyRows: [Bool]
    public private(set) var anyDirty = false
    public var cursorRow = 0
    public var cursorCol = 0
    public var cursorVisible = true
    private var pen = Cell()
    private var wrapPending = false
    private var savedCursor = (row: 0, col: 0)
    private var scrollTop = 0
    private var scrollBottom: Int
    /// Count of sequences this model did not act on, keyed by a short label (evidence of decoder coverage).
    public private(set) var unhandled: [String: Int] = [:]
    public private(set) var bytesFed = 0

    private enum State { case ground, esc, escInter, csi, osc, oscEsc, str, strEsc }
    private var state = State.ground
    private var paramBuf: [UInt8] = []
    private var utf8Need = 0
    private var utf8Acc: UInt32 = 0

    public init(cols: Int, rows: Int) {
        self.cols = max(1, cols)
        self.rows = max(1, rows)
        self.cells = Array(repeating: Cell(), count: self.cols * self.rows)
        self.dirtyRows = Array(repeating: true, count: self.rows)
        self.scrollBottom = self.rows - 1
        self.anyDirty = true
    }

    // MARK: geometry and dirty tracking

    public func resize(cols newCols: Int, rows newRows: Int) {
        guard newCols != cols || newRows != rows else { return }
        cols = max(1, newCols); rows = max(1, newRows)
        cells = Array(repeating: Cell(), count: cols * rows)
        dirtyRows = Array(repeating: true, count: rows)
        anyDirty = true
        cursorRow = 0; cursorCol = 0; wrapPending = false
        scrollTop = 0; scrollBottom = rows - 1
    }

    public func clearAll() {
        for i in cells.indices { cells[i] = Cell() }
        markAllDirty()
    }

    public func markAllDirty() {
        for i in dirtyRows.indices { dirtyRows[i] = true }
        anyDirty = true
    }

    public func takeDirtyRows() -> [Int] {
        guard anyDirty else { return [] }
        var out: [Int] = []
        for i in dirtyRows.indices where dirtyRows[i] { out.append(i); dirtyRows[i] = false }
        anyDirty = false
        return out
    }

    @inline(__always) private func mark(_ r: Int) { dirtyRows[r] = true; anyDirty = true }

    public func cell(_ r: Int, _ c: Int) -> Cell { cells[r * cols + c] }

    public func rowText(_ r: Int, from c0: Int = 0, to c1: Int? = nil) -> String {
        var s = String.UnicodeScalarView()
        let end = min(c1 ?? (cols - 1), cols - 1)
        guard c0 <= end else { return "" }
        for c in c0...end {
            let ch = cells[r * cols + c].ch
            if ch == 0 { continue }
            if let u = Unicode.Scalar(ch) { s.append(u) }
        }
        var str = String(s)
        while str.hasSuffix(" ") { str.removeLast() }
        return str
    }

    // MARK: feeding

    public func feed(_ bytes: [UInt8]) {
        bytesFed += bytes.count
        for b in bytes { step(b) }
    }

    private func count(_ key: String) { unhandled[key, default: 0] += 1 }

    private func step(_ b: UInt8) {
        switch state {
        case .ground:
            if b == 0x1b { state = .esc }
            else if b < 0x20 { control(b) }
            else if b < 0x80 { put(UInt32(b)) }
            else { utf8(b) }
        case .esc:
            state = .ground
            switch b {
            case 0x5b: state = .csi; paramBuf.removeAll(keepingCapacity: true)
            case 0x5d: state = .osc
            case 0x50, 0x58, 0x5e, 0x5f: state = .str
            case 0x28, 0x29, 0x2a, 0x2b, 0x23, 0x25: state = .escInter
            case 0x37: savedCursor = (cursorRow, cursorCol)
            case 0x38: cursorRow = savedCursor.row; cursorCol = savedCursor.col; wrapPending = false
            case 0x44: lineFeed()
            case 0x45: cursorCol = 0; lineFeed()
            case 0x4d: reverseIndex()
            case 0x63: resetState()
            case 0x3d, 0x3e: break
            default: count("ESC \(String(UnicodeScalar(b)))")
            }
        case .escInter:
            state = .ground
        case .csi:
            if b >= 0x40 && b <= 0x7e {
                dispatchCSI(b)
                state = .ground
            } else if b == 0x1b {
                state = .esc
            } else if b < 0x20 {
                control(b)
            } else {
                paramBuf.append(b)
            }
        case .osc:
            if b == 0x07 { state = .ground } else if b == 0x1b { state = .oscEsc }
        case .oscEsc:
            if b == 0x5c { state = .ground } else { state = .esc; step(b) }
        case .str:
            if b == 0x1b { state = .strEsc }
        case .strEsc:
            if b == 0x5c { state = .ground } else { state = .str }
        }
    }

    private func resetState() {
        pen = Cell(); cursorRow = 0; cursorCol = 0; wrapPending = false
        scrollTop = 0; scrollBottom = rows - 1
        clearAll()
    }

    private func utf8(_ b: UInt8) {
        if utf8Need == 0 {
            if b & 0xE0 == 0xC0 { utf8Need = 1; utf8Acc = UInt32(b & 0x1F) }
            else if b & 0xF0 == 0xE0 { utf8Need = 2; utf8Acc = UInt32(b & 0x0F) }
            else if b & 0xF8 == 0xF0 { utf8Need = 3; utf8Acc = UInt32(b & 0x07) }
            else { put(0xFFFD) }
        } else if b & 0xC0 == 0x80 {
            utf8Acc = (utf8Acc << 6) | UInt32(b & 0x3F)
            utf8Need -= 1
            if utf8Need == 0 { put(utf8Acc) }
        } else {
            utf8Need = 0
            put(0xFFFD)
            step(b)
        }
    }

    private func control(_ b: UInt8) {
        switch b {
        case 0x0a, 0x0b, 0x0c: lineFeed()
        case 0x0d: cursorCol = 0; wrapPending = false
        case 0x08: if cursorCol > 0 { cursorCol -= 1 }; wrapPending = false
        case 0x09: cursorCol = min(cols - 1, (cursorCol / 8 + 1) * 8); wrapPending = false
        case 0x07, 0x00, 0x0e, 0x0f: break
        default: count("C0 \(b)")
        }
    }

    private func lineFeed() {
        if cursorRow == scrollBottom { scrollUp(1) } else if cursorRow < rows - 1 { cursorRow += 1 }
    }

    private func reverseIndex() {
        if cursorRow == scrollTop { scrollDown(1) } else if cursorRow > 0 { cursorRow -= 1 }
    }

    private func scrollUp(_ n: Int) {
        let n = min(n, scrollBottom - scrollTop + 1)
        guard n > 0 else { return }
        for r in scrollTop...scrollBottom {
            for c in 0..<cols {
                cells[r * cols + c] = r + n <= scrollBottom ? cells[(r + n) * cols + c] : blank()
            }
            mark(r)
        }
    }

    private func scrollDown(_ n: Int) {
        let n = min(n, scrollBottom - scrollTop + 1)
        guard n > 0 else { return }
        for r in stride(from: scrollBottom, through: scrollTop, by: -1) {
            for c in 0..<cols {
                cells[r * cols + c] = r - n >= scrollTop ? cells[(r - n) * cols + c] : blank()
            }
            mark(r)
        }
    }

    private func blank() -> Cell { Cell(ch: 32, fg: 0, bg: pen.bg, attrs: 0) }

    private func put(_ ch: UInt32) {
        let w = cellWidth(ch)
        if w == 0 { return }
        if wrapPending { cursorCol = 0; lineFeed(); wrapPending = false }
        if w == 2 && cursorCol == cols - 1 { cursorCol = 0; lineFeed() }
        let i = cursorRow * cols + cursorCol
        cells[i] = Cell(ch: ch, fg: pen.fg, bg: pen.bg, attrs: pen.attrs | (w == 2 ? Attr.wide : 0))
        if w == 2 && cursorCol + 1 < cols {
            cells[i + 1] = Cell(ch: 0, fg: pen.fg, bg: pen.bg, attrs: pen.attrs)
        }
        mark(cursorRow)
        cursorCol += w
        if cursorCol >= cols { cursorCol = cols - 1; wrapPending = true }
    }

    // MARK: CSI

    private func dispatchCSI(_ final: UInt8) {
        var isPrivate = false
        var body = paramBuf
        if let f = body.first, f == 0x3f || f == 0x3e || f == 0x3c || f == 0x3d {
            isPrivate = (f == 0x3f)
            body.removeFirst()
        }
        // Intermediate bytes (0x20-0x2f) such as "SP q" are not used by Herdr frames; ignore sequences with them.
        if body.contains(where: { $0 >= 0x20 && $0 <= 0x2f }) { count("CSI intermediate \(String(UnicodeScalar(final)))"); return }
        let text = String(decoding: body, as: UTF8.self)
        let raw = text.split(separator: ";", omittingEmptySubsequences: false).map { String($0) }
        func p(_ i: Int, _ def: Int) -> Int {
            guard i < raw.count, let v = Int(raw[i].split(separator: ":").first ?? "") else { return def }
            return v == 0 ? def : v
        }
        wrapPending = false
        switch final {
        case 0x48, 0x66: // H f CUP
            cursorRow = min(rows - 1, max(0, p(0, 1) - 1)); cursorCol = min(cols - 1, max(0, p(1, 1) - 1))
        case 0x41: cursorRow = max(scrollTop, cursorRow - p(0, 1))
        case 0x42: cursorRow = min(scrollBottom, cursorRow + p(0, 1))
        case 0x43: cursorCol = min(cols - 1, cursorCol + p(0, 1))
        case 0x44: cursorCol = max(0, cursorCol - p(0, 1))
        case 0x45: cursorRow = min(scrollBottom, cursorRow + p(0, 1)); cursorCol = 0
        case 0x46: cursorRow = max(scrollTop, cursorRow - p(0, 1)); cursorCol = 0
        case 0x47, 0x60: cursorCol = min(cols - 1, max(0, p(0, 1) - 1))
        case 0x64: cursorRow = min(rows - 1, max(0, p(0, 1) - 1))
        case 0x4a: eraseDisplay(raw.first.flatMap { Int($0) } ?? 0)
        case 0x4b: eraseLine(raw.first.flatMap { Int($0) } ?? 0)
        case 0x6d: sgr(raw)
        case 0x68, 0x6c: // h l
            if isPrivate {
                for part in raw {
                    switch Int(part) ?? -1 {
                    case 25: cursorVisible = (final == 0x68)
                    case 2026, 7, 1, 1004, 2004, 1049, 47, 1047, 12: break
                    default: count("DECSET \(part)")
                    }
                }
            } else { count("SM/RM \(text)") }
        case 0x73: savedCursor = (cursorRow, cursorCol)
        case 0x75: cursorRow = savedCursor.row; cursorCol = savedCursor.col
        case 0x4c: insertLines(p(0, 1))
        case 0x4d: deleteLines(p(0, 1))
        case 0x40: insertChars(p(0, 1))
        case 0x50: deleteChars(p(0, 1))
        case 0x58: eraseChars(p(0, 1))
        case 0x53: scrollUp(p(0, 1))
        case 0x54: scrollDown(p(0, 1))
        case 0x72:
            let t = max(1, p(0, 1)) - 1, b = min(rows, p(1, rows)) - 1
            if t < b { scrollTop = t; scrollBottom = b }
            cursorRow = 0; cursorCol = 0
        case 0x74, 0x63, 0x6e, 0x71: break // window ops, DA, DSR, cursor style: not applicable to a read-only view
        default: count("CSI \(String(UnicodeScalar(final)))")
        }
    }

    private func fill(row r: Int, from c0: Int, to c1: Int) {
        guard c0 <= c1 else { return }
        for c in c0...c1 { cells[r * cols + c] = blank() }
        mark(r)
    }

    private func eraseDisplay(_ mode: Int) {
        switch mode {
        case 0:
            fill(row: cursorRow, from: cursorCol, to: cols - 1)
            if cursorRow + 1 < rows { for r in (cursorRow + 1)..<rows { fill(row: r, from: 0, to: cols - 1) } }
        case 1:
            for r in 0..<cursorRow { fill(row: r, from: 0, to: cols - 1) }
            fill(row: cursorRow, from: 0, to: cursorCol)
        default:
            for r in 0..<rows { fill(row: r, from: 0, to: cols - 1) }
        }
    }

    private func eraseLine(_ mode: Int) {
        switch mode {
        case 0: fill(row: cursorRow, from: cursorCol, to: cols - 1)
        case 1: fill(row: cursorRow, from: 0, to: cursorCol)
        default: fill(row: cursorRow, from: 0, to: cols - 1)
        }
    }

    private func insertLines(_ n: Int) {
        guard cursorRow >= scrollTop && cursorRow <= scrollBottom else { return }
        let saved = scrollTop; scrollTop = cursorRow; scrollDown(n); scrollTop = saved
    }

    private func deleteLines(_ n: Int) {
        guard cursorRow >= scrollTop && cursorRow <= scrollBottom else { return }
        let saved = scrollTop; scrollTop = cursorRow; scrollUp(n); scrollTop = saved
    }

    private func insertChars(_ n: Int) {
        let n = min(n, cols - cursorCol)
        for c in stride(from: cols - 1, through: cursorCol, by: -1) {
            cells[cursorRow * cols + c] = c - n >= cursorCol ? cells[cursorRow * cols + c - n] : blank()
        }
        mark(cursorRow)
    }

    private func deleteChars(_ n: Int) {
        let n = min(n, cols - cursorCol)
        for c in cursorCol..<cols {
            cells[cursorRow * cols + c] = c + n < cols ? cells[cursorRow * cols + c + n] : blank()
        }
        mark(cursorRow)
    }

    private func eraseChars(_ n: Int) { fill(row: cursorRow, from: cursorCol, to: min(cols - 1, cursorCol + n - 1)) }

    // MARK: SGR

    private func sgr(_ raw: [String]) {
        if raw.isEmpty || (raw.count == 1 && raw[0].isEmpty) { pen.fg = 0; pen.bg = 0; pen.attrs = 0; return }
        // Expand "38:2:r:g:b" style sub-parameters into the semicolon form.
        var codes: [Int] = []
        for part in raw {
            if part.contains(":") {
                let sub = part.split(separator: ":", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
                if sub.first == 4 { codes.append(sub.count > 1 && sub[1] == 0 ? 24 : 4); continue }
                if (sub.first == 38 || sub.first == 48) && sub.count >= 3 {
                    if sub[1] == 2 { let rgb = Array(sub.suffix(3)); codes += [sub[0], 2] + rgb } else { codes += [sub[0], 5, sub[2]] }
                    continue
                }
                codes.append(sub.first ?? 0)
            } else {
                codes.append(Int(part) ?? 0)
            }
        }
        var i = 0
        while i < codes.count {
            let c = codes[i]
            switch c {
            case 0: pen.fg = 0; pen.bg = 0; pen.attrs = 0
            case 1: pen.attrs |= Attr.bold
            case 2: pen.attrs |= Attr.dim
            case 3: pen.attrs |= Attr.italic
            case 4: pen.attrs |= Attr.underline
            case 7: pen.attrs |= Attr.inverse
            case 8: pen.attrs |= Attr.hidden
            case 9: pen.attrs |= Attr.strike
            case 22: pen.attrs &= ~(Attr.bold | Attr.dim)
            case 23: pen.attrs &= ~Attr.italic
            case 24: pen.attrs &= ~Attr.underline
            case 27: pen.attrs &= ~Attr.inverse
            case 28: pen.attrs &= ~Attr.hidden
            case 29: pen.attrs &= ~Attr.strike
            case 30...37: pen.fg = paletteColor(c - 30)
            case 39: pen.fg = 0
            case 40...47: pen.bg = paletteColor(c - 40)
            case 49: pen.bg = 0
            case 90...97: pen.fg = paletteColor(c - 90 + 8)
            case 100...107: pen.bg = paletteColor(c - 100 + 8)
            case 38, 48:
                var color: UInt32? = nil
                if i + 1 < codes.count, codes[i + 1] == 2, i + 4 < codes.count {
                    color = rgbColor(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4
                } else if i + 1 < codes.count, codes[i + 1] == 5, i + 2 < codes.count {
                    color = paletteColor(codes[i + 2]); i += 2
                } else { count("SGR \(c) malformed") }
                if let color = color { if c == 38 { pen.fg = color } else { pen.bg = color } }
            case 5, 6, 25: break
            default: count("SGR \(c)")
            }
            i += 1
        }
    }

    /// Selected text across rows, for copy.
    public func text(from a: (row: Int, col: Int), to b: (row: Int, col: Int)) -> String {
        let (s, e) = (a.row, a.col) <= (b.row, b.col) ? (a, b) : (b, a)
        var lines: [String] = []
        for r in s.row...e.row {
            let c0 = r == s.row ? s.col : 0
            let c1 = r == e.row ? e.col : cols - 1
            lines.append(rowText(r, from: c0, to: c1))
        }
        return lines.joined(separator: "\n")
    }
}
