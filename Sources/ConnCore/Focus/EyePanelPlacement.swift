// Where the eye-break panel goes (decision F20): top centre of the display that has the mouse pointer. Pure geometry in AppKit's coordinates (origin at the
// bottom left of the main display, y up), so it is unit-tested with invented screens.
import CoreGraphics

public enum EyePanelPlacement {
    public static let size = CGSize(width: 428, height: 132)
    /// Space between the top of the usable area (just under the menu bar) and the panel.
    public static let topGap: CGFloat = 14

    /// The index of the screen whose frame holds `pointer`; the first screen (the main display) when no frame does (a pointer on the very edge, or a display that just
    /// went away). nil only when there are no screens.
    public static func screenIndex(containing pointer: CGPoint, frames: [CGRect]) -> Int? {
        guard !frames.isEmpty else { return nil }
        if let i = frames.firstIndex(where: { $0.contains(pointer) }) { return i }
        // The very top and right edges belong to no frame (CGRect.contains is half-open): take the nearest one.
        var best = 0, bestDistance = CGFloat.greatestFiniteMagnitude
        for (i, f) in frames.enumerated() {
            let dx = max(f.minX - pointer.x, 0, pointer.x - f.maxX), dy = max(f.minY - pointer.y, 0, pointer.y - f.maxY)
            let d = dx * dx + dy * dy
            if d < bestDistance { bestDistance = d; best = i }
        }
        return best
    }

    /// The panel's frame: centred on `visibleFrame` (a screen's usable area, under the menu bar), `topGap` below its top edge.
    public static func frame(size: CGSize = EyePanelPlacement.size, visibleFrame: CGRect) -> CGRect {
        CGRect(x: visibleFrame.midX - size.width / 2, y: visibleFrame.maxY - topGap - size.height, width: size.width, height: size.height)
    }
}
