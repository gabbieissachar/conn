import Testing
import HelmCore

@Suite("Scroll back trigger") struct ScrollBackTriggerTests {
    @Test func oneDeliberateUpwardGestureFiresOnceAndItsMomentumDoesNot() {
        var t = ScrollBackTrigger()
        var fires = 0
        for i in 0..<30 { if t.add(deltaY: 4, at: Double(i) * 0.016) { fires += 1 } }   // 30 events in half a second
        #expect(fires == 1)
    }

    @Test func aSmallFlickOrADownwardScrollDoesNotFire() {
        var t = ScrollBackTrigger()
        let first = t.add(deltaY: 3, at: 0), second = t.add(deltaY: 3, at: 0.016)        // 6 points: under the threshold
        #expect(!first && !second)
        var firedDown = false
        for i in 0..<20 { if t.add(deltaY: -5, at: 1 + Double(i) * 0.016) { firedDown = true } }
        #expect(!firedDown)
    }

    @Test func aReversalForgetsWhatWasAddedUp() {
        var t = ScrollBackTrigger()
        _ = t.add(deltaY: 10, at: 0)
        _ = t.add(deltaY: -1, at: 0.016)
        let again = t.add(deltaY: 10, at: 0.032)       // 10 again, not 20
        let enough = t.add(deltaY: 10, at: 0.048)
        #expect(!again && enough)
    }

    @Test func aPauseStartsANewGestureThatCanFireAgain() {
        var t = ScrollBackTrigger()
        let first = t.add(deltaY: 20, at: 0), same = t.add(deltaY: 20, at: 0.1), later = t.add(deltaY: 20, at: 1.0)
        #expect(first && !same && later)               // the same gesture fires once; a second later is a new one
        // Slow scrolling with long gaps never adds up.
        var slow = ScrollBackTrigger()
        var slowFires = 0
        for i in 0..<10 { if slow.add(deltaY: 5, at: Double(i)) { slowFires += 1 } }
        #expect(slowFires == 0)
    }
}
