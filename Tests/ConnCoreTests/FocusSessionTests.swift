// The focus session state machine (decisions F4, F6, F7, F15): driven by hand-moved dates, never by waiting.
import Testing
import Foundation
import ConnCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

@Suite("Focus session") struct FocusSessionTests {
    @Test func startsRunningWithADeadlineAndCountsDown() {
        var s = FocusSession()
        #expect(s.isIdle && s.remaining(at: t0) == 0)
        let events = s.start(minutes: 25, now: t0)
        #expect(events == [.started] && s.isRunning && s.isActive && !s.isDone)
        #expect(s.endsAt == at(1500) && s.startedAt == t0 && s.lengthMinutes == 25)
        #expect(s.remaining(at: at(0)) == 1500 && s.remaining(at: at(600)) == 900 && s.remaining(at: at(1499)) == 1)
        #expect(abs(s.progress(at: at(750)) - 0.5) < 0.0001)
    }

    @Test func theLengthIsClampedToOneToOneHundredEighty() {
        var s = FocusSession()
        s.start(minutes: 0, now: t0); #expect(s.lengthMinutes == 1 && s.endsAt == at(60))
        s.stopEarly(now: t0)
        s.start(minutes: 9999, now: t0); #expect(s.lengthMinutes == 180 && s.endsAt == at(10_800))
        #expect(FocusSession.clamped(-5) == 1 && FocusSession.clamped(25) == 25 && FocusSession.clamped(181) == 180)
    }

    @Test func aSecondStartWhileActiveChangesNothing() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        let before = s
        #expect(s.start(minutes: 60, now: at(30)).isEmpty && s.restart(now: at(30)).isEmpty)
        #expect(s == before)
        s.pause(now: at(60))
        let paused = s
        #expect(s.start(minutes: 60, now: at(90)).isEmpty && s == paused)
    }

    @Test func pauseFreezesTheTimeLeftAndResumeSetsANewDeadline() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        #expect(s.pause(now: at(600)) == [.paused])
        #expect(s.isPaused && s.isActive && !s.isRunning && s.endsAt == nil)
        #expect(s.remaining(at: at(600)) == 900 && s.remaining(at: at(5000)) == 900)        // a pause does not run down
        #expect(s.tick(now: at(9000)).isEmpty && s.isPaused)                                // and cannot finish
        #expect(s.resume(now: at(1000)) == [.resumed])
        #expect(s.endsAt == at(1900) && s.remaining(at: at(1000)) == 900)
        // pausing and resuming when not applicable does nothing
        #expect(s.resume(now: at(1001)).isEmpty)
        var idle = FocusSession()
        #expect(idle.pause(now: t0).isEmpty && idle.resume(now: t0).isEmpty && idle.isIdle)
    }

    @Test func plusFiveMinutesLengthensTheRunWhetherRunningOrPaused() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        #expect(s.extend(now: at(100)) == [.extended] && s.endsAt == at(1800))
        s.pause(now: at(200))
        #expect(s.remaining(at: at(200)) == 1600)
        #expect(s.extend(now: at(210)) == [.extended] && s.remaining(at: at(210)) == 1900)
        #expect(s.lengthMinutes == 25)        // Restart repeats the chosen length, not the extension
        var idle = FocusSession()
        #expect(idle.extend(now: t0).isEmpty)
    }

    @Test func plusFiveNeverTakesTheTimeLeftPastOneHundredEightyMinutes() {
        var s = FocusSession()
        s.start(minutes: 180, now: t0)
        #expect(s.extend(now: t0).isEmpty && s.endsAt == at(10_800))        // already at the cap
        s.start(minutes: 178, now: t0)                                       // refused: still running
        s.stopEarly(now: t0)
        s.start(minutes: 178, now: t0)
        #expect(s.extend(now: t0) == [.extended] && s.remaining(at: t0) == 10_800)        // 178 + 5 stops at 180
        #expect(s.extend(now: t0).isEmpty)
    }

    @Test func stopEarlyGoesBackToIdleAndReportsWhatWasFocused() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        s.pause(now: at(300))          // 300 s focused
        s.resume(now: at(400))
        let events = s.stopEarly(now: at(460))          // 60 s more
        #expect(events == [.ended(.stoppedEarly, focusedSeconds: 360)])
        #expect(s.isIdle && s.endsAt == nil && s.remaining(at: at(460)) == 0 && s.lengthMinutes == 25)
        #expect(s.stopEarly(now: at(470)).isEmpty)
    }

    @Test func stoppingWhilePausedCountsTheTimeFocusedBeforeThePause() {
        var s = FocusSession()
        s.start(minutes: 10, now: t0)
        s.pause(now: at(120))
        #expect(s.stopEarly(now: at(900)) == [.ended(.stoppedEarly, focusedSeconds: 120)])
    }

    @Test func theTimeRunningOutIsDoneAndNothingStartsByItself() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        #expect(s.tick(now: at(1499)).isEmpty && s.isRunning)
        #expect(s.tick(now: at(1500)) == [.ended(.finished, focusedSeconds: 1500)])
        #expect(s.isDone && !s.isActive && s.endsAt == nil && s.remaining(at: at(1500)) == 0)
        #expect(s.tick(now: at(9000)).isEmpty && s.isDone)          // stays Done: no automatic restart
        #expect(s.focused(at: at(9000)) == 1500 && s.progress(at: at(9000)) == 1)
        #expect(s.pause(now: at(9000)).isEmpty && s.extend(now: at(9000)).isEmpty && s.stopEarly(now: at(9000)).isEmpty)
    }

    @Test func aLateTickAfterSleepCountsOnlyUpToTheDeadline() {
        var s = FocusSession()
        s.start(minutes: 25, now: t0)
        s.pause(now: at(600)); s.resume(now: at(700))          // 600 s focused, 900 s to go, deadline at 1600
        #expect(s.tick(now: at(50_000)) == [.ended(.finished, focusedSeconds: 1500)])
    }

    @Test func restartRepeatsTheLastLengthFromDone() {
        var s = FocusSession()
        s.start(minutes: 45, now: t0)
        s.tick(now: at(2700))
        #expect(s.isDone)
        #expect(s.restart(now: at(3000)) == [.started])
        #expect(s.isRunning && s.endsAt == at(3000 + 2700) && s.focused(at: at(3000)) == 0 && s.startedAt == at(3000))
    }

    @Test func dismissDoneAndStartAnotherLength() {
        var s = FocusSession()
        s.start(minutes: 15, now: t0); s.tick(now: at(900))
        #expect(s.dismissDone() && s.isIdle && !s.dismissDone())
        #expect(s.start(minutes: 90, now: at(1000)) == [.started] && s.lengthMinutes == 90)
        // starting straight from Done with another length is allowed too
        s.tick(now: at(1000 + 5400))
        #expect(s.isDone && s.start(minutes: 25, now: at(7000)) == [.started] && s.lengthMinutes == 25)
    }

    @Test func pausingAtTheVeryMomentTheTimeIsUpEndsTheSession() {
        var s = FocusSession()
        s.start(minutes: 1, now: t0)
        #expect(s.pause(now: at(60)) == [.ended(.finished, focusedSeconds: 60)] && s.isDone)
    }
}
