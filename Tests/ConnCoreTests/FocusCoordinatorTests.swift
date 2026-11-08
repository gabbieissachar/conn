// The whole feature on stand-ins and a hand-moved clock: the session and the eye clock together, the marker file, the Focus switching (On, the check, Off, a launch
// after a crash, quit), the chimes, the panel, and the daily total. No sound, no `shortcuts`, no window, no waiting.
import Testing
import Foundation
import Combine
import ConnCore

@MainActor
private final class Rig {
    let clock = ManualFocusClock(Date(timeIntervalSince1970: 1_800_000_000))
    let sw: ScriptedFocusSwitch
    let status = ScriptedFocusStatus()
    let chimes = SilentChimes()
    let panel = ScriptedPanel()
    let presence = ScriptedPresence()
    let ticker = ManualTicker()
    let dir: URL
    let markerFile: FocusMarkerFile
    let defaults: UserDefaults
    let totalsStore: FocusTotalsStore
    let coordinator: FocusCoordinator

    init(defaults existing: UserDefaults? = nil, dir existingDir: URL? = nil, switchResults: [FocusSwitchResult] = [.done], pid: Int32 = 4242) {
        let name = "conn.tests.focus.coordinator.\(UUID().uuidString)"
        defaults = existing ?? UserDefaults(suiteName: name)!
        if existing == nil { defaults.removePersistentDomain(forName: name) }
        dir = existingDir ?? FileManager.default.temporaryDirectory.appendingPathComponent("conn-focus-rig-\(UUID().uuidString)", isDirectory: true)
        markerFile = FocusMarkerFile(directory: dir)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        totalsStore = FocusTotalsStore(defaults: defaults, calendar: cal)
        sw = ScriptedFocusSwitch(results: switchResults)
        coordinator = FocusCoordinator(clock: clock, focusSwitch: sw, status: status, chimes: chimes, panel: panel, presence: presence, ticker: ticker,
                                       marker: markerFile, totals: totalsStore, prefs: FocusPrefs(defaults: defaults), pid: pid)
        status.switchState = { [sw] in sw.focusIsOn }
        coordinator.pause = { _ in }          // the confirm loop does not wait
    }

    func advance(_ s: TimeInterval) { clock.advance(by: s); coordinator.tick() }
    var marker: FocusMarker? { markerFile.read() }
}

@Suite("Focus coordinator: a session") @MainActor struct FocusSessionFlowTests {
    @Test func startingTurnsTheFocusOnChecksItAndWritesTheMarker() async {
        let r = Rig()
        r.coordinator.start(minutes: 25)
        #expect(r.coordinator.session.isRunning && r.coordinator.link == .switchingOn)
        let now = Int(r.clock.now.timeIntervalSince1970)
        #expect(r.marker == FocusMarker(pid: 4242, startedAt: now, endsAt: now + 1500))
        await r.coordinator.settled()
        #expect(r.sw.calls == [true] && r.coordinator.link == .onConfirmed)
        #expect(r.ticker.interval == 1)          // a running session ticks every second
    }

    @Test func pauseKeepsTheFocusOnAndTheMarkerWithNoDeadlineAndResumeWritesANewOne() async {
        let r = Rig()
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        r.advance(600)
        r.coordinator.pauseSession()
        let started = Int(r.coordinator.session.startedAt!.timeIntervalSince1970)
        #expect(r.coordinator.session.isPaused && r.marker == FocusMarker(pid: 4242, startedAt: started, endsAt: nil))
        await r.coordinator.settled()
        #expect(r.sw.calls == [true] && r.coordinator.link == .onConfirmed)          // F15: no Off while paused
        r.advance(5000)
        #expect(r.coordinator.session.isPaused && r.coordinator.session.remaining(at: r.clock.now) == 900)
        r.coordinator.resumeSession()
        #expect(r.marker?.endsAt == Int(r.clock.now.timeIntervalSince1970) + 900)
        #expect(r.sw.calls == [true])
    }

    @Test func plusFiveRewritesTheMarkerWithTheLaterDeadline() {
        let r = Rig()
        r.coordinator.start(minutes: 25)
        let before = r.marker!.endsAt!
        r.coordinator.extendSession()
        #expect(r.marker!.endsAt == before + 300)
    }

    @Test func theTimeRunningOutChimesRemovesTheMarkerSwitchesTheFocusOffAndStaysDone() async {
        let r = Rig()
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        r.advance(1499)
        #expect(r.coordinator.session.isRunning && r.marker != nil && r.chimes.played.isEmpty)
        r.advance(1)
        #expect(r.coordinator.session.isDone && r.marker == nil && r.chimes.played == [.sessionEnded])
        await r.coordinator.settled()
        #expect(r.sw.calls == [true, false] && r.coordinator.link == .off)          // F16: off at once, not at Restart
        r.advance(10_000)
        #expect(r.coordinator.session.isDone && r.sw.calls == [true, false] && r.chimes.played == [.sessionEnded])          // nothing starts by itself
        #expect(r.coordinator.dayTotal(at: r.clock.now).focusedSeconds == 1500)
        #expect(r.ticker.interval == nil)          // nothing left to tick
    }

    @Test func restartRunsTheSameLengthAgain() async {
        let r = Rig()
        r.coordinator.start(minutes: 15); await r.coordinator.settled()
        r.advance(900); await r.coordinator.settled()
        r.coordinator.restart(); await r.coordinator.settled()
        #expect(r.coordinator.session.isRunning && r.coordinator.session.remaining(at: r.clock.now) == 900 && r.sw.calls == [true, false, true] && r.marker != nil)
    }

    @Test func stopEarlyEndsTheMarkerAndTheFocusWithoutAChimeAndCountsTheTimeFocused() async {
        let r = Rig()
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        r.advance(420)
        r.coordinator.stopEarly(); await r.coordinator.settled()
        #expect(r.coordinator.session.isIdle && r.marker == nil && r.chimes.played.isEmpty)
        #expect(r.sw.calls == [true, false] && r.coordinator.link == .off)
        #expect(r.coordinator.dayTotal(at: r.clock.now).focusedSeconds == 420)
    }

    @Test func theDayTotalIncludesTheRunThatIsOnRightNow() {
        let r = Rig()
        r.coordinator.start(minutes: 25)
        r.advance(300)
        #expect(r.coordinator.dayTotal(at: r.clock.now).focusedSeconds == 300)
        r.coordinator.pauseSession(); r.advance(900)
        #expect(r.coordinator.dayTotal(at: r.clock.now).focusedSeconds == 300)          // a pause does not count
    }

    @Test func aQuickStopThenStartKeepsTheCallsInOrder() async {
        let r = Rig()
        r.sw.delay = 0.05
        r.coordinator.start(minutes: 10)
        r.coordinator.stopEarly()
        r.coordinator.start(minutes: 10)
        await r.coordinator.settled()
        #expect(r.sw.calls == [true, false, true] && r.coordinator.link == .onConfirmed && r.coordinator.session.isRunning)
    }

    @Test func endingWhileTheOnShortcutRunsEndsWithTheFocusOff() async {
        let r = Rig()
        r.sw.delay = 0.05
        r.coordinator.start(minutes: 1)
        r.advance(60)
        await r.coordinator.settled()
        #expect(r.sw.calls == [true, false] && r.coordinator.link == .off && r.coordinator.session.isDone)
    }

    @Test func theLengthYouChoseIsOfferedNextTime() {
        let r = Rig()
        r.coordinator.start(minutes: 45)
        #expect(r.coordinator.chosenMinutes == 45)
        let again = FocusCoordinator(clock: r.clock, focusSwitch: r.sw, status: r.status, chimes: r.chimes, panel: r.panel, presence: r.presence, ticker: ManualTicker(),
                                     marker: r.markerFile, totals: r.totalsStore, prefs: FocusPrefs(defaults: r.defaults))
        #expect(again.chosenMinutes == 45 && again.session.lengthMinutes == 45)
    }
}

@Suite("Focus coordinator: did the Focus really turn on") @MainActor struct FocusLinkTests {
    @Test func aShortcutThatFailsIsARedWarningAndTheSessionGoesOnWithoutTheFocus() async {
        let r = Rig(switchResults: [.failed("Error: Couldn't find shortcut")])
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.coordinator.link == .didNotSwitchOn("the shortcut said: Error: Couldn't find shortcut") && r.coordinator.link.isRed)
        #expect(r.coordinator.session.isRunning && r.marker != nil)
    }

    @Test func aTimeOutIsRed() async {
        let r = Rig(switchResults: [.timedOut])
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.coordinator.link == .didNotSwitchOn("the shortcut did not finish in time"))
    }

    @Test func tryAgainRunsTheOnShortcutAgainAndClearsTheWarning() async {
        let r = Rig(switchResults: [.timedOut, .done])
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.coordinator.link.isRed)
        r.coordinator.retryFocus(); await r.coordinator.settled()
        #expect(r.sw.calls == [true, true] && r.coordinator.link == .onConfirmed)
    }

    @Test func theShortcutRanButMacOSSaysNoFocusIsOn() async {
        let r = Rig()
        r.status.fixed = true; r.status.answer = false
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.coordinator.link == .didNotSwitchOn("macOS does not show a Focus as on"))
        #expect(r.status.asks >= 7)          // it asked for about three seconds, then said so
    }

    @Test func aFocusThatComesOnAfterAMomentIsStillConfirmed() async {
        let r = Rig()
        r.status.fixed = true; r.status.answer = nil          // no answer yet
        var asked = 0
        r.coordinator.pause = { _ in asked += 1; if asked == 3 { r.status.answer = true } }
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.coordinator.link == .onConfirmed && asked == 3)
    }

    @Test func notAllowedFocusStatusIsNeutralNotRed() async {
        let r = Rig()
        r.status.authorization = .denied; r.status.authorizationAfterRequest = .denied
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        if case .onUnconfirmed = r.coordinator.link { #expect(!r.coordinator.link.isRed) } else { Issue.record("expected a neutral state, got \(r.coordinator.link)") }
        #expect(r.coordinator.statusAccess == .denied)
    }

    @Test func theFirstStartAsksMacOSOnceAndThenChecks() async {
        let r = Rig()
        r.status.authorization = .notDetermined
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        #expect(r.status.requests == 1 && r.coordinator.link == .onConfirmed && r.coordinator.statusAccess == .authorized)
    }

    @Test func aFocusThatWasAlreadyOnCannotBeConfirmedSoItIsNeutral() async {
        let r = Rig()
        r.status.fixed = true; r.status.answer = true          // some Focus (a schedule, say) was on before Conn Focus
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        if case .onUnconfirmed(let why) = r.coordinator.link { #expect(why.contains("already on")) } else { Issue.record("expected neutral, got \(r.coordinator.link)") }
    }

    @Test func anOffThatFailsIsARedWarningAndTryAgainRunsItAgain() async {
        let r = Rig(switchResults: [.done, .timedOut, .done])
        r.coordinator.start(minutes: 1); await r.coordinator.settled()
        r.advance(60); await r.coordinator.settled()
        #expect(r.coordinator.link == .couldNotSwitchOff("the shortcut did not finish in time") && r.coordinator.link.isRed)
        #expect(FocusPrefs(defaults: r.defaults).focusMayBeOn)          // still marked as possibly on
        r.coordinator.retrySwitchOff(); await r.coordinator.settled()
        #expect(r.coordinator.link == .off && !FocusPrefs(defaults: r.defaults).focusMayBeOn)
    }

    @Test func checkSetupOnlyLists() async {
        let r = Rig()
        r.sw.setSetup(.missing([.off]))
        await r.coordinator.checkSetup()
        #expect(r.coordinator.setupStatus == .missing([.off]) && r.sw.setupChecks == 1 && r.sw.calls.isEmpty && r.sw.blockingCalls.isEmpty)
        await r.coordinator.requestFocusStatusAccess()
        #expect(r.status.requests == 1)
    }
}

@Suite("Focus coordinator: launch and quit") @MainActor struct FocusLaunchQuitTests {
    @Test func quitEndsTheSessionRemovesTheMarkerAndSwitchesTheFocusOffAndWaitsForIt() async {
        let r = Rig()
        r.coordinator.start(minutes: 25); await r.coordinator.settled()
        r.advance(600)
        r.coordinator.shutdown()
        #expect(r.marker == nil && r.coordinator.isShutDown && r.sw.blockingCalls == [false] && r.ticker.interval == nil)
        #expect(!FocusPrefs(defaults: r.defaults).focusMayBeOn)
        #expect(r.totalsStore.today(at: r.clock.now).focusedSeconds == 600)
        r.coordinator.shutdown()          // twice is the same as once
        #expect(r.sw.blockingCalls == [false])
        r.coordinator.start(minutes: 25)
        #expect(r.coordinator.session.isIdle)          // nothing starts after quit
    }

    @Test func quitWithNoSessionDoesNotRunTheOffShortcut() {
        let r = Rig()
        r.coordinator.shutdown()
        #expect(r.sw.blockingCalls.isEmpty && r.sw.calls.isEmpty)
    }

    @Test func aCrashLeavesTheFocusMarkedOnAndTheNextLaunchSwitchesItOffAndSaysSo() async {
        let first = Rig()
        first.coordinator.start(minutes: 25); await first.coordinator.settled()
        // the first Conn dies here: no shutdown. Its pid is gone, and the flag and the marker are what it left.
        FocusMarkerFile(directory: first.dir).write(FocusMarker(pid: 2_000_000, startedAt: Int(first.clock.now.timeIntervalSince1970), endsAt: nil))
        #expect(FocusPrefs(defaults: first.defaults).focusMayBeOn)
        let next = Rig(defaults: first.defaults, dir: first.dir)
        next.coordinator.launch(); await next.coordinator.settled()
        #expect(next.sw.calls == [false] && !FocusPrefs(defaults: next.defaults).focusMayBeOn && next.coordinator.link == .off)
        #expect(next.coordinator.notice == "Conn Focus was still on from the last run. It is off now.")
        #expect(next.marker == nil)          // the stale marker is gone
        next.coordinator.dismissNotice()
        #expect(next.coordinator.notice == nil)
    }

    @Test func aLaunchThatCannotSwitchTheFocusOffSaysItMayStillBeOn() async {
        let first = Rig()
        first.coordinator.start(minutes: 25); await first.coordinator.settled()
        let next = Rig(defaults: first.defaults, dir: first.dir, switchResults: [.failed("no")])
        next.coordinator.launch(); await next.coordinator.settled()
        #expect(next.coordinator.link == .couldNotSwitchOff("the shortcut said: no") && FocusPrefs(defaults: next.defaults).focusMayBeOn)
    }

    @Test func aCleanLaunchRunsNothing() async {
        let r = Rig()
        r.coordinator.launch(); await r.coordinator.settled()
        #expect(r.sw.calls.isEmpty && r.coordinator.notice == nil && r.coordinator.link == .off && r.ticker.interval == nil)
    }

    @Test func aLiveOwnersMarkerIsKeptAtLaunch() {
        let r = Rig()
        let now = Int(Date().timeIntervalSince1970)
        r.markerFile.write(FocusMarker(pid: getpid(), startedAt: now, endsAt: now + 600))
        r.coordinator.launch()
        #expect(r.marker != nil)
    }
}

@Suite("Focus coordinator: eye breaks") @MainActor struct FocusEyeFlowTests {
    @Test func theEyeClockRunsWithoutASessionAndRemembersItsSwitch() {
        let r = Rig()
        #expect(!r.coordinator.eyeEnabled && r.ticker.interval == nil)
        r.coordinator.setEyeEnabled(true)
        #expect(r.coordinator.eyeEnabled && r.coordinator.session.isIdle && r.ticker.interval == 5)          // idle: a look every few seconds, not every second
        #expect(FocusPrefs(defaults: r.defaults).eyeEnabled)
        let again = Rig(defaults: r.defaults)
        again.coordinator.launch()
        #expect(again.coordinator.eyeEnabled)          // on at the next launch
        r.coordinator.setEyeEnabled(false)
        #expect(!r.coordinator.eyeEnabled && r.ticker.interval == nil && !FocusPrefs(defaults: r.defaults).eyeEnabled)
    }

    @Test func aBreakChimesShowsThePanelAndEndsWithAChimeAndOneTakenOnTheTotal() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        r.advance(1200)
        #expect(r.coordinator.eye.isOnBreak && r.panel.isUp && r.panel.presented == 1 && r.chimes.played == [.eyeBreakStarted] && r.ticker.interval == 1)
        r.advance(19)
        #expect(r.panel.isUp)
        r.advance(1)
        #expect(!r.coordinator.eye.isOnBreak && !r.panel.isUp && r.panel.completedCount == 1 && r.chimes.played == [.eyeBreakStarted, .eyeBreakEnded])
        #expect(r.totalsStore.today(at: r.clock.now).breaksTaken == 1 && r.totalsStore.today(at: r.clock.now).breaksSkipped == 0 && r.ticker.interval == 5)
    }

    @Test func skipCountsAsSkippedAndIsSilent() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true); r.advance(1200)
        r.coordinator.skipBreak()
        #expect(!r.panel.isUp && r.chimes.played == [.eyeBreakStarted])
        let t = r.totalsStore.today(at: r.clock.now)
        #expect(t.breaksSkipped == 1 && t.breaksTaken == 0 && r.coordinator.eye.secondsUntilBreak(at: r.clock.now) == 1200)
    }

    @Test func snoozeBringsItBackInTwoMinutesAndCountsAsNothing() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true); r.advance(1200)
        r.coordinator.snoozeBreak()
        #expect(!r.panel.isUp && r.panel.presented == 1)
        let t = r.totalsStore.today(at: r.clock.now)
        #expect(t.breaksSkipped == 0 && t.breaksTaken == 0)
        r.advance(119); #expect(!r.panel.isUp)
        r.advance(1); #expect(r.panel.isUp && r.panel.presented == 2)
    }

    @Test func lockingTheScreenRestartsTheTwentyMinutesAndAwayShowsNoPanel() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        r.advance(900)
        r.presence.screenLocked = true; r.advance(5)
        r.advance(1000)          // well past the break time, but away
        #expect(!r.panel.isUp && r.panel.presented == 0)
        r.presence.screenLocked = false; r.presence.idleSeconds = 0; r.advance(1)
        #expect(r.coordinator.eye.secondsUntilBreak(at: r.clock.now) == 1200)
        r.advance(1199); #expect(!r.panel.isUp)
        r.advance(1); #expect(r.panel.isUp)
    }

    @Test func twoMinutesWithoutInputIsAwayToo() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        r.advance(1000)
        r.presence.idleSeconds = 130; r.advance(1)
        r.advance(300)
        #expect(!r.panel.isUp)
        r.presence.idleSeconds = 1; r.advance(1)
        #expect(r.coordinator.eye.secondsUntilBreak(at: r.clock.now) == 1200)
    }

    @Test func switchingTheEyeClockOffDuringABreakClosesThePanel() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true); r.advance(1200)
        #expect(r.panel.isUp)
        r.coordinator.setEyeEnabled(false)
        #expect(!r.panel.isUp)
        let t = r.totalsStore.today(at: r.clock.now)
        #expect(t.breaksTaken == 0 && t.breaksSkipped == 0)
    }

    @Test func aBreakDuringASessionDoesNotTouchTheSession() async {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        r.coordinator.start(minutes: 60); await r.coordinator.settled()
        r.advance(1200)
        #expect(r.panel.isUp && r.coordinator.session.isRunning && r.marker != nil)
        r.advance(20)
        #expect(!r.panel.isUp && r.coordinator.session.isRunning && r.sw.calls == [true])
    }

    @Test func quitClosesAnOpenPanel() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true); r.advance(1200)
        r.coordinator.shutdown()
        #expect(!r.panel.isUp)
    }

    @Test func aCountdownViewAsksForSecondTicksWhileItIsOnScreen() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        #expect(r.ticker.interval == 5)
        r.coordinator.beginWatching(); #expect(r.ticker.interval == 1)
        r.coordinator.endWatching(); #expect(r.ticker.interval == 5)
    }

    @Test func tickingDoesNotAnnounceAChangeWhenNothingChanged() {
        let r = Rig()
        r.coordinator.setEyeEnabled(true)
        var changes = 0
        let c = r.coordinator.objectWillChange.sink { changes += 1 }
        for _ in 0..<10 { r.advance(1) }
        #expect(changes == 0)
        c.cancel()
    }
}
