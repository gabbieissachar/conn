// Colours for a terminal pane, shared by the SwiftTerm view and the cell-grid view so the two renderers match.
import AppKit
import SwiftTerm

public struct TerminalTheme {
    public var bg: NSColor
    public var fg: NSColor
    public var ansi: [NSColor]
    public var selection: NSColor

    public static func hex(_ v: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }

    public static let light = TerminalTheme(
        bg: hex(0xFBF7EA), fg: hex(0x3A3935),
        ansi: [0x3A3935, 0xC4412E, 0x4C7A26, 0xA2711A, 0x2D68AD, 0xA03C88, 0x1E8686, 0x8C877A,
               0x6B675D, 0xDD5A42, 0x5D9A2E, 0xC1881F, 0x3F80CC, 0xB950A0, 0x29A1A1, 0xD8D2C0].map(hex),
        selection: NSColor(srgbRed: 0.22, green: 0.45, blue: 0.85, alpha: 0.28))

    public static let dark = TerminalTheme(
        bg: hex(0x16171B), fg: hex(0xD6D8DC),
        ansi: [0x1E1F24, 0xF0646A, 0x7FC464, 0xE5C068, 0x6AA4F0, 0xC58AEA, 0x56C8C8, 0xC9CCD2,
               0x6C7078, 0xF58187, 0x98D67D, 0xF0D182, 0x8DBBF7, 0xD7A6F2, 0x7BDADA, 0xF2F3F5].map(hex),
        selection: NSColor(srgbRed: 0.40, green: 0.62, blue: 0.98, alpha: 0.32))

    /// SwiftTerm's 16-bit-per-channel palette entries.
    var swiftTermPalette: [SwiftTerm.Color] {
        ansi.map { c in
            let s = c.usingColorSpace(.sRGB) ?? c
            return SwiftTerm.Color(red: UInt16(s.redComponent * 65535), green: UInt16(s.greenComponent * 65535), blue: UInt16(s.blueComponent * 65535))
        }
    }
}
