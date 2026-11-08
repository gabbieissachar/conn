// The 20-20-20 eye clock (decisions F8 to F11): breaks at the interval, Skip, Snooze, and the away rule, all on hand-moved dates.
import Testing
import Foundation
import ConnCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
private let here = PresenceSample()

@Suite("Eye clock") struct EyeBreakClockTests {
    @Test func offDoesNothingAndEnableStartsTwentyMinutes() {
        var e = EyeBreakClock()
        #expect(!e.isOn && e.tick(now: at(99_999), presence: here).isEmpty && e.secondsUntilBreak(at: t0) == nil)
        #expect(e.enable(now: t0) && e.isOn && !e.enable(now: at(5)))
        #expect(e.secondsUntilBreak(at: t0) == 1200 && e.secondsUntilBreak(at: at(300)) == 900)
    }

    @Test func aBreakStartsAtTwentyMinutesAndEndsAfterTwentySeconds() {
        var e = EyeBreakClock(); e.enable(now: t0)
        #expect(e.tick(now: at(1199), presence: here).isEmpty)
        #expect(e.tick(now: at(1200), presence: here) == [.breakStarted] && e.isOnBreak)
        #expect(e.breakSecondsLeft(at: at(1200)) == 20 && e.breakSecondsLeft(at: at(1210)) == 10 && e.secondsUntilBreak(at: at(1200)) == nil)
        #expect(e.tick(now: at(1219), presence: here).isEmpty && e.isOnBreak)
        #expect(e.tick(now: at(1220), presence: here) == [.breakEnded(.completed)] && !e.isOnBreak)
        // the next break is a full twenty minutes after the end of this one
        #expect(e.secondsUntilBreak(at: at(1220)) == 1200 && e.tick(now: at(2419), presence: here).isEmpty && e.tick(now: at(2420), presence: here) == [.breakStarted])
    }

    @Test func skipEndsTheBreakAndRestartsTheFullInterval() {
        var e = EyeBreakClock(); e.enable(now: t0); e.tick(now: at(1200), presence: here)
        #expect(e.skip(now: at(1203)) == [.breakEnded(.skipped)] && !e.isOnBreak && e.secondsUntilBreak(at: at(1203)) == 1200)
        #expect(e.skip(now: at(1204)).isEmpty)          // nothing to skip
    }

    @Test func snoozeBringsTheBreakBackInTwoMinutesAndCountsAsNeither() {
        var e = EyeBreakClock(); e.enable(now: t0); e.tick(now: at(1200), presence: here)
        #expect(e.snooze(now: at(1205)) == [.snoozed] && !e.isOnBreak && e.secondsUntilBreak(at: at(1205)) == 120)
        #expect(e.tick(now: at(1324), presence: here).isEmpty && e.tick(now: at(1325), presence: here) == [.breakStarted])
        #expect(e.snooze(now: at(1326)) == [.snoozed])          // again, as often as wanted
        var calm = EyeBreakClock(); calm.enable(now: t0)
        #expect(calm.snooze(now: at(5)).isEmpty)
    }

    @Test func noInputForTwoMinutesIsAwayAndTheClockStartsOverOnReturn() {
        var e = EyeBreakClock(); e.enable(now: t0)
        let idle = PresenceSample(idleSeconds: 120)
        #expect(e.tick(now: at(600), presence: PresenceSample(idleSeconds: 119)).isEmpty && e.awaySince == nil)        // 119 s is not away
        #expect(e.tick(now: at(700), presence: idle).isEmpty && e.awaySince == at(700))
        #expect(e.tick(now: at(1300), presence: PresenceSample(idleSeconds: 700)).isEmpty)          // still away: no break at 1200 either
        #expect(e.tick(now: at(1400), presence: PresenceSample(idleSeconds: 2)) == [.clockRestarted] && e.awaySince == nil)
        #expect(e.secondsUntilBreak(at: at(1400)) == 1200)
    }

    @Test func aLockedScreenOrASleepingDisplayIsAway() {
        var e = EyeBreakClock(); e.enable(now: t0)
        #expect(e.tick(now: at(10), presence: PresenceSample(idleSeconds: 3, screenLocked: true)).isEmpty && e.awaySince == at(10))
        #expect(e.tick(now: at(20), presence: PresenceSample(idleSeconds: 3, asleep: true)).isEmpty && e.awaySince == at(10))
        #expect(e.tick(now: at(30), presence: here) == [.clockRestarted] && e.secondsUntilBreak(at: at(30)) == 1200)
    }

    @Test func aLockBetweenTwoSamplesStillRestartsTheClock() {
        var e = EyeBreakClock(); e.enable(now: t0)
        let back = PresenceSample(idleSeconds: 1, leftSinceLastSample: true)          // locked and unlocked since the last look
        #expect(e.tick(now: at(500), presence: back) == [.clockRestarted] && e.secondsUntilBreak(at: at(500)) == 1200)
    }

    @Test func nothingStartsWhileAwayEvenWhenTheBreakIsDue() {
        var e = EyeBreakClock(); e.enable(now: t0)
        #expect(e.tick(now: at(1250), presence: PresenceSample(screenLocked: true)).isEmpty && !e.isOnBreak)
    }

    @Test func leavingTheScreenDuringABreakEndsItAsTaken() {
        var e = EyeBreakClock(); e.enable(now: t0); e.tick(now: at(1200), presence: here)
        #expect(e.tick(now: at(1205), presence: PresenceSample(screenLocked: true)) == [.breakEnded(.leftTheScreen)] && !e.isOnBreak)
        #expect(e.tick(now: at(1300), presence: here) == [.clockRestarted])
        // a lock that came and went between samples, during a break: ended, then restarted
        var f = EyeBreakClock(); f.enable(now: t0); f.tick(now: at(1200), presence: here)
        #expect(f.tick(now: at(1205), presence: PresenceSample(leftSinceLastSample: true)) == [.breakEnded(.leftTheScreen), .clockRestarted])
    }

    @Test func switchingOffDuringABreakEndsItWithoutCountingIt() {
        var e = EyeBreakClock(); e.enable(now: t0); e.tick(now: at(1200), presence: here)
        #expect(e.disable() == [.breakEnded(.switchedOff)] && !e.isOn)
        #expect(e.disable().isEmpty)
        #expect(e.tick(now: at(5000), presence: here).isEmpty)
    }

    @Test func presenceRuleIsAnyOfLockSleepOrTwoMinutesIdle() {
        #expect(!PresenceSample(idleSeconds: 119.9).isAway(after: 120))
        #expect(PresenceSample(idleSeconds: 120).isAway(after: 120) && PresenceSample(screenLocked: true).isAway(after: 120) && PresenceSample(asleep: true).isAway(after: 120))
    }
}
