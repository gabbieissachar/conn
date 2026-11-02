import Testing

/// Everything that drives SwiftTerm on the main actor lives under this one serialized parent. A hostile stream can keep the
/// main thread busy for a second or more (in a debug build), and the draw-timing test waits on the same thread, so the
/// two must not run at the same time.
@Suite("SwiftTerm on the main actor", .serialized) enum SwiftTermMainActorTests {}
