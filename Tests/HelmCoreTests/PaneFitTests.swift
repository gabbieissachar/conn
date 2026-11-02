import Testing
import CoreGraphics
import HelmCore

@Suite("Pane font fit") struct PaneFitTests {
    /// A monospaced font: cells 0.6 em wide and 1.2 em tall, snapped to whole pixels like the real ones.
    private func cell(_ p: CGFloat) -> CGSize { CGSize(width: (p * 0.6).rounded(), height: (p * 1.2).rounded(.up)) }
    private func fits(_ p: CGFloat, _ cols: Int, _ rows: Int, _ w: CGFloat, _ h: CGFloat) -> Bool {
        cell(p).width * CGFloat(cols) <= w && cell(p).height * CGFloat(rows) <= h
    }

    @Test func theLargestSizeThatFitsBothWidthAndHeight() {
        // 100 x 30 cells in 1000 x 600: width allows 16.5 pt (cell 10), height allows 16 pt (cell 20 x 30 = 600).
        let p = PaneFit.fitPoints(cols: 100, rows: 30, availableWidth: 1000, availableHeight: 600, cell: cell)
        #expect(fits(p, 100, 30, 1000, 600))
        #expect(!fits(p + PaneFit.step, 100, 30, 1000, 600) || p == PaneFit.ceilingPoints)
    }

    @Test func aWideRoomIsLimitedByHeightAndATallOneByWidth() {
        let wide = PaneFit.fitPoints(cols: 80, rows: 40, availableWidth: 3000, availableHeight: 500, cell: cell)
        let tall = PaneFit.fitPoints(cols: 80, rows: 40, availableWidth: 500, availableHeight: 3000, cell: cell)
        #expect(fits(wide, 80, 40, 3000, 500) && !fits(wide + PaneFit.step, 80, 40, 3000, 500))   // height decided
        #expect(fits(tall, 80, 40, 500, 3000) && !fits(tall + PaneFit.step, 80, 40, 500, 3000))   // width decided
        #expect(wide < 14 && tall < 14)
    }

    @Test func aBiggerRoomNeverGivesSmallerText() {
        var last: CGFloat = 0
        for w in stride(from: 300.0, through: 3000.0, by: 100.0) {
            let p = PaneFit.fitPoints(cols: 120, rows: 40, availableWidth: CGFloat(w), availableHeight: CGFloat(w) * 0.6, cell: cell)
            #expect(p >= last)
            last = p
        }
    }

    @Test func theFitStaysBetweenTheFloorAndTheCeiling() {
        #expect(PaneFit.fitPoints(cols: 500, rows: 300, availableWidth: 200, availableHeight: 200, cell: cell) == PaneFit.floorPoints)     // too small: crop
        #expect(PaneFit.fitPoints(cols: 20, rows: 5, availableWidth: 4000, availableHeight: 4000, cell: cell) == PaneFit.ceilingPoints)    // huge room
        #expect(PaneFit.fitPoints(cols: 0, rows: 10, availableWidth: 500, availableHeight: 500, cell: cell) == PaneFit.floorPoints)
        #expect(PaneFit.fitPoints(cols: 80, rows: 24, availableWidth: 0, availableHeight: 500, cell: cell) == PaneFit.floorPoints)
    }

    @Test func noRandomRoomEverOverflowsAboveTheFloor() {
        var g = SystemRandomNumberGenerator()
        for _ in 0..<300 {
            let cols = Int.random(in: 20...300, using: &g), rows = Int.random(in: 5...120, using: &g)
            let w = CGFloat.random(in: 200...3000, using: &g), h = CGFloat.random(in: 200...2000, using: &g)
            let p = PaneFit.fitPoints(cols: cols, rows: rows, availableWidth: w, availableHeight: h, cell: cell)
            #expect(p == PaneFit.floorPoints || fits(p, cols, rows, w, h), "\(cols)x\(rows) in \(w)x\(h) gave \(p)")
            #expect(p == PaneFit.ceilingPoints || !fits(p + PaneFit.step, cols, rows, w, h), "\(cols)x\(rows) in \(w)x\(h): \(p) is not the largest")
        }
    }

    @Test func zoomScalesTheFitAndStaysInRange() {
        let fit = PaneFit.fitPoints(cols: 100, rows: 30, availableWidth: 1000, availableHeight: 600, cell: cell)
        #expect(PaneFit.points(cols: 100, rows: 30, availableWidth: 1000, availableHeight: 600, zoom: 1, cell: cell) == fit)
        let bigger = PaneFit.points(cols: 100, rows: 30, availableWidth: 1000, availableHeight: 600, zoom: 1.25, cell: cell)
        let smaller = PaneFit.points(cols: 100, rows: 30, availableWidth: 1000, availableHeight: 600, zoom: 0.8, cell: cell)
        #expect(bigger > fit && smaller < fit)
        #expect(abs(bigger - fit * 1.25) <= PaneFit.step && abs(smaller - fit * 0.8) <= PaneFit.step)
        #expect(PaneFit.points(cols: 20, rows: 5, availableWidth: 4000, availableHeight: 4000, zoom: 2, cell: cell) == PaneFit.zoomedRange.upperBound)
        #expect(PaneFit.points(cols: 500, rows: 300, availableWidth: 100, availableHeight: 100, zoom: 0.6, cell: cell) == PaneFit.zoomedRange.lowerBound)
    }

    @Test func zoomStepsStopAtTheEndsAndOneIsTheFit() {
        #expect(PaneFit.zoomLevels.contains(1))
        #expect(PaneFit.stepZoom(1, direction: 1) == 1.1 && PaneFit.stepZoom(1, direction: -1) == 0.9)
        #expect(PaneFit.stepZoom(2.0, direction: 1) == 2.0 && PaneFit.stepZoom(0.6, direction: -1) == 0.6)
        var z = 1.0
        for _ in 0..<30 { z = PaneFit.stepZoom(z, direction: 1) }
        #expect(z == 2.0)
        #expect(PaneFit.clampedZoom(1.12) == 1.1 && PaneFit.clampedZoom(.nan) == 1 && PaneFit.clampedZoom(0) == 0.6 && PaneFit.clampedZoom(99) == 2.0)
    }
}
