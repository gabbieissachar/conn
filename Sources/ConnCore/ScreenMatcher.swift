// Pairs the screens a stream showed with the sightings of the same text by a poller of Herdr's own `pane.read`, to
// estimate how far the stream trails the server's view. Pure functions so the matching rule has tests.
import Foundation

public struct Sighting: Equatable, Sendable {
    public var t: UInt64              // when the screen was first seen (nanoseconds, monotonic)
    public var text: String
    /// When the previous poll replied without having seen this text yet (0 if none): the change happened after it.
    public var previousPollAt: UInt64
    public init(t: UInt64, text: String, previousPollAt: UInt64 = 0) { self.t = t; self.text = text; self.previousPollAt = previousPollAt }
}

public enum ScreenMatcher {
    public struct Result: Equatable, Sendable {
        /// frame time minus the first poll that saw the text (the stream cannot be later than this says: a lower bound on lag)
        public var lowerBoundMillis: [Double] = []
        /// frame time minus the last poll that had not yet seen it (an upper bound on lag)
        public var upperBoundMillis: [Double] = []
        public var unmatched = 0
    }

    /// For each stream screen after the first, find the latest poll sighting of the same text that is not later than the
    /// frame plus `tolerance` (poll noise), and not more than `window` earlier. Panes with a spinner repeat the same few
    /// screens, so taking the first sighting ever would pair a screen with an earlier cycle and read seconds of lag.
    public static func match(stream: [Sighting], polls: [Sighting], tolerance: UInt64 = 150_000_000, window: UInt64 = 1_500_000_000) -> Result {
        var r = Result()
        for s in stream {
            var hit: Sighting?
            for p in polls.reversed() {
                if p.t > s.t &+ tolerance { continue }
                if s.t > p.t && s.t - p.t > window { break }
                if p.text == s.text { hit = p; break }
            }
            guard let h = hit else { r.unmatched += 1; continue }
            r.lowerBoundMillis.append((Double(s.t) - Double(h.t)) / 1e6)
            if h.previousPollAt > 0 { r.upperBoundMillis.append((Double(s.t) - Double(h.previousPollAt)) / 1e6) }
        }
        return r
    }
}
