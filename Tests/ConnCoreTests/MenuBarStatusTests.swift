// What the menu-bar item and the focus line at the top of its menu say, state by state (README "The menu-bar item"). Driven by hand-moved dates.
import Testing
import Foundation
import ConnCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
private let utc = TimeZone(identifier: "UTC")!
private let en = Locale(identifier: "en_GB")

private func running(minutes: Int = 25) -> FocusSession {
    var s = FocusSession()
    s.start(minutes: minutes, now: t0)
    return s
}

@Suite("Menu bar item") struct MenuBarStatusTests {
    @Test func theLogoStandsAloneWhenNothingWaitsAndNoSessionRuns() {
        let m = MenuBarStatus.make(waiting: 0, session: FocusSession(), link: .off, now: t0)
        #expect(m.countText == nil && m.timeText == nil && m.focusSymbol == nil && m.focus == .none && !m.warning)
        #expect(m.accessibilityText == "Conn, nothing is waiting on you")
    }

    @Test func theCountShowsOnlyWhenSomethingWaits() {
        #expect(MenuBarStatus.make(waiting: 2, session: FocusSession(), link: .off, now: t0).countText == "2")
        #expect(MenuBarStatus.make(waiting: 2, session: FocusSession(), link: .off, now: t0).accessibilityText == "Conn, 2 sessions are waiting on you")
        #expect(MenuBarStatus.make(waiting: 1, session: FocusSession(), link: .off, now: t0).accessibilityText == "Conn, 1 session is waiting on you")
        #expect(MenuBarStatus(waiting: -3, focus: .none, warning: false, timeText: nil).waiting == 0)
    }

    @Test func aRunningSessionShowsTheTimeLeftWithNoGlyph() {
        let s = running()
        #expect(MenuBarStatus.make(waiting: 0, session: s, link: .onConfirmed, now: t0).timeText == "25:00")
        let m = MenuBarStatus.make(waiting: 2, session: s, link: .onConfirmed, now: at(75))
        #expect(m.focus == .running && m.timeText == "23:45" && m.focusSymbol == nil && m.countText == "2" && !m.warning)
        #expect(m.accessibilityText == "Conn, 2 sessions are waiting on you, focus session, 23:45 left")
    }

    @Test func aPausedSessionFreezesTheTimeAndShowsAPauseGlyph() {
        var s = running()
        s.pause(now: at(600))
        let a = MenuBarStatus.make(waiting: 0, session: s, link: .onConfirmed, now: at(600))
        let b = MenuBarStatus.make(waiting: 0, session: s, link: .onConfirmed, now: at(9_000))
        #expect(a == b && a.focus == .paused && a.timeText == "15:00" && a.focusSymbol == "pause.fill")
    }

    @Test func doneSaysDoneWithACheck() {
        var s = running()
        s.tick(now: at(1500))
        let m = MenuBarStatus.make(waiting: 0, session: s, link: .off, now: at(1500))
        #expect(m.focus == .done && m.timeText == "Done" && m.focusSymbol == "checkmark")
    }

    @Test func aRedConnFocusWinsTheGlyphInEveryState() {
        let red = FocusLink.didNotSwitchOn("no shortcut")
        let r = MenuBarStatus.make(waiting: 0, session: running(), link: red, now: at(60))
        #expect(r.warning && r.focusSymbol == "exclamationmark.triangle.fill" && r.timeText == "24:00")
        #expect(r.accessibilityText.hasSuffix("Conn Focus is not on, other apps' banners are not silenced"))
        // With no session a red "may still be on" is a triangle alone: banners stay silenced, so it has to be seen.
        let idle = MenuBarStatus.make(waiting: 0, session: FocusSession(), link: .couldNotSwitchOff("x"), now: t0)
        #expect(idle.warning && idle.focusSymbol == "exclamationmark.triangle.fill" && idle.timeText == nil)
        // A neutral "on but not confirmed" is not an alarm.
        #expect(!MenuBarStatus.make(waiting: 0, session: running(), link: .onUnconfirmed("x"), now: t0).warning)
    }

    @Test func theTimeIsRoundedUpLikeTheToolbarPill() {
        var s = FocusSession(); s.start(minutes: 1, now: t0)
        #expect(MenuBarStatus.make(waiting: 0, session: s, link: .onConfirmed, now: at(59.2)).timeText == "0:01")
        #expect(MenuBarStatus.make(waiting: 0, session: s, link: .onConfirmed, now: at(60)).timeText == "0:00")
    }
}

@Suite("Menu focus line") struct MenuFocusLineTests {
    private func line(_ s: FocusSession, _ link: FocusLink = .onConfirmed, now: Date) -> MenuFocusLine {
        MenuFocusLine.make(session: s, link: link, now: now, timeZone: utc, locale: en)
    }

    @Test func idleOffersToStart() {
        let l = line(FocusSession(), .off, now: t0)
        #expect(l.title == "Focus session" && l.detail == "Not running" && l.warning == nil && l.actions == [.openControls])
    }

    @Test func runningSaysTimeLeftAndEndTimeAndOffersPauseAndFiveMore() {
        let l = line(running(), now: at(60))
        // t0 = 2027-01-15 08:00:00 UTC, so a 25-minute session started at t0 ends at 08:25.
        #expect(l.title == "Focus 24:00 left" && l.detail == "25 min · ends 08:25" && l.actions == [.pause, .extend, .openControls] && l.warning == nil)
    }

    @Test func pausedOffersResume() {
        var s = running(); s.pause(now: at(300))
        let l = line(s, now: at(5_000))
        #expect(l.title == "Paused, 20:00 left" && l.detail == "25 min" && l.actions == [.resume, .extend, .openControls])
    }

    @Test func doneOffersRestartAndCountsTheFocusedMinutes() {
        var s = running(); s.tick(now: at(1500))
        let l = line(s, .off, now: at(1600))
        #expect(l.title == "Focus session done" && l.detail == "25 min focused" && l.actions == [.restart, .openControls])
    }

    @Test func aRedStateAddsTheSentenceAndTryAgainFirst() {
        let l = line(running(), .didNotSwitchOn("x"), now: at(60))
        #expect(l.warning == "Conn Focus did not switch on" && l.actions == [.retry, .pause, .extend, .openControls])
        let off = line(FocusSession(), .couldNotSwitchOff("x"), now: t0)
        #expect(off.warning == "Conn Focus may still be on" && off.actions == [.retry, .openControls])
    }
}
