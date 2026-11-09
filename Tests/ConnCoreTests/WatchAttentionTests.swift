import Testing
import Foundation
import ConnCore

@Suite("Watch focus: hidden columns and the cue a finished turn leaves") struct WatchAttentionTests {
    let a = "aaaaaaaa-0000-4000-8000-000000000001"
    let b = "bbbbbbbb-0000-4000-8000-000000000002"
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    @Test func aSessionIsHiddenUntilItIsShownAndNothingHappensToItMeanwhileWhenItNeverWorked() {
        var w = WatchAttention()
        #expect(!w.isHidden(a) && w.isEmpty)
        w.hide(a, state: .idle)
        #expect(w.isHidden(a) && !w.isHidden(b))
        let r1 = w.observe(a, state: .idle, now: at(1))
        #expect(!r1)
        let r2 = w.advance(now: at(60))
        #expect(r2.isEmpty && w.cue(for: a) == nil)
        let r3 = w.show(a)
        #expect(r3 == nil)
        #expect(!w.isHidden(a))
    }

    @Test func aTurnThatEndsWhileHiddenRaisesACueOnceTheSessionHasStayedStopped() {
        var w = WatchAttention()
        w.hide(a, state: .idle)
        let r4 = w.observe(a, state: .working, now: at(0))
        #expect(!r4)
        let stopped = w.observe(a, state: .idle, now: at(10))             // stopped, not yet settled
        #expect(!stopped)
        #expect(w.cue(for: a) == nil && w.nextSettle == at(10 + WatchAttention.settle))
        let r5 = w.observe(a, state: .idle, now: at(11))
        #expect(!r5)
        let r6 = w.advance(now: at(10 + WatchAttention.settle))
        #expect(r6 == [a])
        #expect(w.cue(for: a) == .finished && w.cueTime(for: a) == at(10 + WatchAttention.settle))
        #expect(w.nextSettle == nil)
    }

    @Test func aSessionAlreadyWorkingWhenHiddenOwesACueForThatTurn() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .done, now: at(0))
        let r7 = w.advance(now: at(WatchAttention.settle))
        #expect(r7 == [a])
        #expect(w.cue(for: a) == .finished)
    }

    @Test func aPauseBetweenToolCallsIsNotATurnEnding() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .idle, now: at(0))
        let r8 = w.advance(now: at(1))
        #expect(r8.isEmpty)
        _ = w.observe(a, state: .working, now: at(2))                 // it carried on
        #expect(w.nextSettle == nil)
        let r9 = w.advance(now: at(30))
        #expect(r9.isEmpty && w.cue(for: a) == nil)
        _ = w.observe(a, state: .idle, now: at(40))
        let r10 = w.advance(now: at(40 + WatchAttention.settle))
        #expect(r10 == [a])
    }

    @Test func aTurnThatEndsOnAQuestionSaysTheSessionNeedsThePerson() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .blocked, now: at(0))
        let r11 = w.observe(a, state: .blocked, now: at(WatchAttention.settle))
        #expect(r11)
        #expect(w.cue(for: a) == .needsYou)
    }

    @Test func aStateWithNoSignalOrAnUnknownOneChangesNothing() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        let r12 = w.observe(a, state: nil, now: at(0))
        #expect(!r12)
        let r13 = w.observe(a, state: .unknown, now: at(100))
        #expect(!r13)
        #expect(w.cue(for: a) == nil && w.nextSettle == nil)
        _ = w.observe(a, state: .idle, now: at(101))
        let r14 = w.advance(now: at(101 + WatchAttention.settle))
        #expect(r14 == [a])
    }

    @Test func theCueStaysUntilTheColumnIsShownAndShowingReturnsItAndForgetsIt() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .idle, now: at(0))
        _ = w.advance(now: at(5))
        _ = w.observe(a, state: .working, now: at(100))               // it started another turn: the cue is still there
        #expect(w.cue(for: a) == .finished)
        let r15 = w.advance(now: at(200))
        #expect(r15.isEmpty && w.cue(for: a) == .finished)
        let r16 = w.show(a)
        #expect(r16 == .finished)
        #expect(!w.isHidden(a) && w.cue(for: a) == nil)
        let r17 = w.show(a)
        #expect(r17 == nil)
    }

    @Test func aLaterTurnEndingWhileTheCueIsStillUpUpdatesIt() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .idle, now: at(0)); _ = w.advance(now: at(5))
        #expect(w.cue(for: a) == .finished)
        _ = w.observe(a, state: .working, now: at(100))
        _ = w.observe(a, state: .blocked, now: at(110))
        let r18 = w.advance(now: at(110 + WatchAttention.settle))
        #expect(r18 == [a])
        #expect(w.cue(for: a) == .needsYou)
    }

    @Test func eachHiddenSessionKeepsItsOwnStateAndOnlySessionsStillInWatchStayHidden() {
        var w = WatchAttention()
        w.hide(a, state: .working); w.hide(b, state: .idle)
        _ = w.observe(a, state: .idle, now: at(0)); _ = w.observe(b, state: .idle, now: at(0))
        let r19 = w.advance(now: at(10))
        #expect(r19 == [a])
        #expect(w.cue(for: a) == .finished && w.cue(for: b) == nil && w.isHidden(b))
        let r20 = w.keep(only: [b])
        #expect(r20)
        #expect(!w.isHidden(a) && w.isHidden(b))
        let r21 = w.keep(only: [b])
        #expect(!r21)
    }

    @Test func hidingAgainStartsFromNothing() {
        var w = WatchAttention()
        w.hide(a, state: .working)
        _ = w.observe(a, state: .idle, now: at(0)); _ = w.advance(now: at(10))
        w.hide(a, state: .idle)
        #expect(w.cue(for: a) == nil && w.isHidden(a))
    }

    @Test func whatIsKeptIsTheSessionIdsAndAPendingCueAndNothingMore() throws {
        var w = WatchAttention()
        w.hide(a, state: .working); w.hide(b, state: .idle)
        _ = w.observe(a, state: .idle, now: at(0)); _ = w.advance(now: at(10))
        let data = try #require(w.encoded())
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains(a) && text.contains(b) && text.contains("finished"))
        let back = WatchAttention.decode(data)
        #expect(back.isHidden(a) && back.isHidden(b) && back.cue(for: a) == .finished && back.cue(for: b) == nil)
        #expect(back.cueTime(for: a) == at(10))
        // After a launch nothing is known to be running: the first sighting of the session working says so.
        var again = back
        _ = again.observe(b, state: .working, now: at(20)); _ = again.observe(b, state: .idle, now: at(30))
        let r22 = again.advance(now: at(40))
        #expect(r22 == [b] && again.cue(for: b) == .finished)
    }

    @Test func unreadableOrForeignDataIsNothingHidden() {
        #expect(WatchAttention.decode(nil).isEmpty)
        #expect(WatchAttention.decode(Data("not json".utf8)).isEmpty)
        #expect(WatchAttention.decode(Data(#"{"v":2,"hidden":{"x":{}}}"#.utf8)).isEmpty)
        #expect(WatchAttention.decode(Data(#"{"v":1,"hidden":{"":{}}}"#.utf8)).isEmpty)
    }
}
