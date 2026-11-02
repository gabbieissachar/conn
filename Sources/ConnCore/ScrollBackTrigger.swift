// Turns the mouse wheel or trackpad over a live pane into "open its history" (the pane itself cannot scroll: see the
// history view). One deliberate upward gesture opens it; a stray flick, a downward scroll, or the tail of a gesture that
// already opened it does not.
import Foundation

public struct ScrollBackTrigger: Sendable {
    /// Upward points a gesture must add up to before it counts (a flick of a trackpad is about 3 to 10 per event).
    public var threshold: Double
    /// A pause this long ends the gesture and forgets what it added up to.
    public var gap: TimeInterval
    private var accumulated = 0.0
    private var lastAt: TimeInterval?
    private var fired = false

    public init(threshold: Double = 14, gap: TimeInterval = 0.35) { self.threshold = threshold; self.gap = gap }

    /// `deltaY` as AppKit reports it (`scrollingDeltaY`): positive means the content moves down, that is, earlier output
    /// is being asked for. Returns true once per gesture, when it has asked for enough.
    public mutating func add(deltaY: Double, at time: TimeInterval) -> Bool {
        if let l = lastAt, time - l > gap { accumulated = 0; fired = false }
        lastAt = time
        if deltaY < 0 { accumulated = 0; return false }       // scrolling down: not a request for history
        guard !fired else { return false }
        accumulated += deltaY
        if accumulated >= threshold { fired = true; accumulated = 0; return true }
        return false
    }
}
