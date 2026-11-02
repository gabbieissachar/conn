// How large the text of a live pane should be.
//
// Herdr's pane has a fixed grid (for example 167 by 59 cells) that an observer cannot change, so the only thing Conn can
// choose is the size of the text: the largest at which the whole grid fits the room the pane has, in both width and
// height. The cell size of a font is not a clean multiple of its point size (cells snap to whole pixels), so the fit takes
// the cell size from the caller, who knows the view that will draw it. A zoom factor then scales the fitted size: below 1
// leaves a margin, above 1 makes the text larger than the room (the left and top edges crop; `Cmd+0` returns to the fit).
import Foundation
import CoreGraphics

public enum PaneFit {
    /// The smallest and largest sizes the fit picks. Below the floor the grid is cropped instead of made unreadable.
    public static let floorPoints: CGFloat = 7
    public static let ceilingPoints: CGFloat = 28
    public static let step: CGFloat = 0.5
    /// The zoom steps of Cmd+= and Cmd+-, with 1 as the fit itself.
    public static let zoomLevels: [Double] = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0]
    /// Zoom never takes the text outside this range, whatever the fit was.
    public static let zoomedRange: ClosedRange<CGFloat> = 5...56

    /// The largest size in `floorPoints...ceilingPoints` (in `step`s) at which `cols` by `rows` cells fit the room.
    /// `cell` gives the size of one cell at a font size and must not shrink as the size grows.
    public static func fitPoints(cols: Int, rows: Int, availableWidth: CGFloat, availableHeight: CGFloat, cell: (CGFloat) -> CGSize) -> CGFloat {
        guard cols > 0, rows > 0, availableWidth > 0, availableHeight > 0 else { return floorPoints }
        func fits(_ p: CGFloat) -> Bool {
            let c = cell(p)
            return c.width * CGFloat(cols) <= availableWidth && c.height * CGFloat(rows) <= availableHeight
        }
        let steps = Int(((ceilingPoints - floorPoints) / step).rounded())
        guard fits(floorPoints) else { return floorPoints }
        var lo = 0, hi = steps                      // lo always fits
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if fits(floorPoints + CGFloat(mid) * step) { lo = mid } else { hi = mid - 1 }
        }
        return floorPoints + CGFloat(lo) * step
    }

    /// The fit, scaled by `zoom` and rounded to a half point.
    public static func points(cols: Int, rows: Int, availableWidth: CGFloat, availableHeight: CGFloat, zoom: Double = 1, cell: (CGFloat) -> CGSize) -> CGFloat {
        let fit = fitPoints(cols: cols, rows: rows, availableWidth: availableWidth, availableHeight: availableHeight, cell: cell)
        guard zoom != 1 else { return fit }
        let scaled = (fit * CGFloat(zoom) / step).rounded() * step
        return min(max(scaled, zoomedRange.lowerBound), zoomedRange.upperBound)
    }

    /// The next zoom step up (`direction` > 0) or down; the ends stay put. A stored value that is not a step snaps to the nearest.
    public static func stepZoom(_ zoom: Double, direction: Int) -> Double {
        let i = nearestLevel(zoom)
        return zoomLevels[min(max(i + (direction > 0 ? 1 : -1), 0), zoomLevels.count - 1)]
    }

    public static func clampedZoom(_ zoom: Double) -> Double { zoom.isFinite ? zoomLevels[nearestLevel(zoom)] : 1 }

    private static func nearestLevel(_ zoom: Double) -> Int {
        zoomLevels.indices.min { abs(zoomLevels[$0] - zoom) < abs(zoomLevels[$1] - zoom) } ?? 4
    }
}
