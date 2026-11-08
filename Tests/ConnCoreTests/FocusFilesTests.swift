// The daily total, the preferences, the marker file (decision F14: the contract with the agent notifier) and the panel's placement (decision F20).
import Testing
import Foundation
import ConnCore

private func freshDefaults() -> UserDefaults {
    let name = "conn.tests.focus.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

private func scratchDir() -> URL {
    let u = FileManager.default.temporaryDirectory.appendingPathComponent("conn-focus-test-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
    return u
}

private var utc: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
private func date(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12, _ min: Int = 0) -> Date {
    utc.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
}

@Suite("Focus daily total") @MainActor struct FocusTotalsTests {
    @Test func countsTodayAndStartsFromZeroTheNextDay() {
        let store = FocusTotalsStore(defaults: freshDefaults(), calendar: utc)
        let morning = date(2026, 11, 8, 9)
        #expect(store.today(at: morning) == FocusDayTotal(day: "2026-11-08"))
        store.addFocused(1500, at: morning); store.addFocused(600, at: morning)
        store.addBreak(taken: true, at: morning); store.addBreak(taken: true, at: morning); store.addBreak(taken: false, at: morning)
        let t = store.today(at: date(2026, 11, 8, 23, 59))
        #expect(t.focusedSeconds == 2100 && t.breaksTaken == 2 && t.breaksSkipped == 1)
        // local midnight: the next day reads zero without anything being deleted, and the new day then replaces the old
        #expect(store.today(at: date(2026, 11, 9, 0, 0)) == FocusDayTotal(day: "2026-11-09"))
        store.addFocused(60, at: date(2026, 11, 9, 0, 1))
        #expect(store.today(at: date(2026, 11, 9, 8)).focusedSeconds == 60)
    }

    @Test func keepsOnlyThreeNumbersAndADayAndSurvivesARelaunch() {
        let d = freshDefaults()
        FocusTotalsStore(defaults: d, calendar: utc).addFocused(90, at: date(2026, 11, 8))
        #expect(FocusTotalsStore(defaults: d, calendar: utc).today(at: date(2026, 11, 8)).focusedSeconds == 90)
        let raw = d.dictionary(forKey: FocusTotalsStore.defaultKey) ?? [:]
        #expect(Set(raw.keys) == ["day", "focused", "taken", "skipped"])
        d.set("junk", forKey: FocusTotalsStore.defaultKey)
        #expect(FocusTotalsStore(defaults: d, calendar: utc).today(at: date(2026, 11, 8)).focusedSeconds == 0)
    }

    @Test func durationsReadInPlainWords() {
        #expect(FocusDayTotal.durationText(seconds: 0) == "0 min" && FocusDayTotal.durationText(seconds: 40) == "under a minute")
        #expect(FocusDayTotal.durationText(seconds: 25 * 60) == "25 min" && FocusDayTotal.durationText(seconds: 85 * 60) == "1 h 25 min" && FocusDayTotal.durationText(seconds: 120 * 60) == "2 h")
    }

    @Test func preferencesDefaultToEyeOffAndTwentyFiveMinutes() {
        let d = freshDefaults()
        let p = FocusPrefs(defaults: d)
        #expect(!p.eyeEnabled && p.minutes == 25 && !p.focusMayBeOn)
        p.eyeEnabled = true; p.minutes = 9999; p.focusMayBeOn = true
        let again = FocusPrefs(defaults: d)
        #expect(again.eyeEnabled && again.minutes == 180 && again.focusMayBeOn)
    }
}

@Suite("Focus marker file") struct FocusMarkerTests {
    @Test func theFileHasTheDocumentedShape() throws {
        let dir = scratchDir(); let file = FocusMarkerFile(directory: dir)
        #expect(file.write(FocusMarker(pid: 4242, startedAt: 1_793_000_000, endsAt: 1_793_001_500)))
        let text = try String(contentsOf: file.url, encoding: .utf8)
        #expect(text == "{\"pid\": 4242, \"started_at\": 1793000000, \"ends_at\": 1793001500}\n")
        let o = try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        #expect(o["pid"] as? Int == 4242 && o["started_at"] as? Int == 1_793_000_000 && o["ends_at"] as? Int == 1_793_001_500)
        #expect(file.url.lastPathComponent == "focus-session.json")
        // paused: ends_at is null, still valid JSON
        #expect(file.write(FocusMarker(pid: 4242, startedAt: 1_793_000_000, endsAt: nil)))
        let paused = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file.url)) as? [String: Any])
        #expect(paused["ends_at"] is NSNull && paused["pid"] as? Int == 4242)
        #expect(file.read() == FocusMarker(pid: 4242, startedAt: 1_793_000_000, endsAt: nil))
    }

    @Test func theDefaultFolderIsConnsApplicationSupportFolder() {
        #expect(FocusMarker.defaultDirectory().path.hasSuffix("/Library/Application Support/Conn"))
    }

    @Test func aWriteLeavesNoTemporaryFileBehindAndReplacesTheOldOneWhole() throws {
        let dir = scratchDir(); let file = FocusMarkerFile(directory: dir)
        for i in 0..<20 { #expect(file.write(FocusMarker(pid: 1000 + Int32(i), startedAt: 1_793_000_000, endsAt: 1_793_000_000 + i))) }
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names == ["focus-session.json"])
        #expect(file.read()?.pid == 1019)
    }

    @Test func removeIsComplete() {
        let file = FocusMarkerFile(directory: scratchDir())
        #expect(file.remove())          // nothing there is fine
        file.write(FocusMarker(pid: 1, startedAt: 1, endsAt: nil))
        #expect(file.exists && file.remove() && !file.exists)
    }

    @Test func aMarkerWhoseOwnerIsGoneIsStaleAndOneWithALiveOwnerIsKept() {
        let me = getpid()
        let now = Int(Date().timeIntervalSince1970)
        let live = FocusMarkerFile(directory: scratchDir())
        live.write(FocusMarker(pid: me, startedAt: now, endsAt: now + 60))
        #expect(!live.removeIfStale() && live.exists)          // this test process is alive and older than the marker
        // a pid that does not exist
        let gone = FocusMarkerFile(directory: scratchDir())
        gone.write(FocusMarker(pid: 2_000_000, startedAt: now, endsAt: now + 60))
        #expect(gone.removeIfStale() && !gone.exists)
        // a live pid that started AFTER the marker says the session began: the pid was reused, so the owner is gone
        let reused = FocusMarkerFile(directory: scratchDir())
        reused.write(FocusMarker(pid: me, startedAt: 1_000, endsAt: nil))
        #expect(reused.removeIfStale() && !reused.exists)
        // something that is not a marker at all
        let junk = FocusMarkerFile(directory: scratchDir())
        try? Data("not json".utf8).write(to: junk.url)
        #expect(junk.removeIfStale() && !junk.exists)
        // nothing there: nothing removed
        #expect(!FocusMarkerFile(directory: scratchDir()).removeIfStale())
    }

    @Test func parsingRefusesWhatIsNotAMarker() {
        for bad in ["", "[]", "{}", "{\"pid\": 0, \"started_at\": 1}", "{\"pid\": 5}", "{\"pid\": \"x\", \"started_at\": 1}", "{\"pid\": 5, \"started_at\": 1, \"ends_at\": \"soon\"}"] {
            #expect(FocusMarker.parse(Data(bad.utf8)) == nil, "\(bad)")
        }
        #expect(FocusMarker.parse(Data("{\"pid\": 5, \"started_at\": 1}".utf8)) == FocusMarker(pid: 5, startedAt: 1, endsAt: nil))
    }
}

@Suite("Eye panel placement") struct EyePanelPlacementTests {
    private let main = CGRect(x: 0, y: 0, width: 1728, height: 1117)
    private let right = CGRect(x: 1728, y: -200, width: 2560, height: 1440)

    @Test func topCentreOfTheUsableArea() {
        let visible = CGRect(x: 0, y: 0, width: 1728, height: 1117 - 38)          // under the menu bar
        let f = EyePanelPlacement.frame(visibleFrame: visible)
        #expect(f.midX == visible.midX && f.size == EyePanelPlacement.size)
        #expect(f.maxY == visible.maxY - EyePanelPlacement.topGap)
        #expect(visible.contains(f))
    }

    @Test func theDisplayWithThePointerWinsAndTheMainDisplayIsTheFallback() {
        let frames = [main, right]
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 100, y: 100), frames: frames) == 0)
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 2000, y: 900), frames: frames) == 1)
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 1727.9, y: 50), frames: frames) == 0)
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 1728, y: 50), frames: frames) == 1)
        // on the very top edge (outside both half-open rectangles): the nearest one
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 300, y: 1117), frames: frames) == 0)
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 3000, y: 1240), frames: frames) == 1)
        #expect(EyePanelPlacement.screenIndex(containing: CGPoint(x: 5, y: 5), frames: []) == nil)
    }

    @Test func aDisplayAboveOrBelowAlsoWorks() {
        let above = CGRect(x: 0, y: 1117, width: 1920, height: 1080)
        let f = EyePanelPlacement.frame(visibleFrame: above)
        #expect(f.midX == above.midX && f.maxY < above.maxY && f.minY > above.minY)
    }
}

@Suite("Focus time format") struct FocusTimeFormatTests {
    @Test func aCountdownRoundsUpSoItNeverShowsZeroWhileTimeIsLeft() {
        #expect(FocusTimeFormat.clock(1500) == "25:00" && FocusTimeFormat.clock(1499.2) == "25:00" && FocusTimeFormat.clock(1498.9) == "24:59")
        #expect(FocusTimeFormat.clock(0.4) == "0:01" && FocusTimeFormat.clock(0) == "0:00" && FocusTimeFormat.clock(-3) == "0:00")
        #expect(FocusTimeFormat.clock(65) == "1:05" && FocusTimeFormat.clock(3600) == "1:00:00" && FocusTimeFormat.clock(3669) == "1:01:09" && FocusTimeFormat.clock(10_800) == "3:00:00")
    }

    @Test func theEndTimeIsShortAndInThePersonsZone() {
        let utc = TimeZone(identifier: "UTC")!
        let d = Date(timeIntervalSince1970: 1_800_000_000)          // 2027-01-15 08:00 UTC
        #expect(FocusTimeFormat.endTime(d, locale: Locale(identifier: "en_GB"), timeZone: utc) == "08:00")
        #expect(FocusTimeFormat.endTime(d, locale: Locale(identifier: "en_US"), timeZone: utc).hasPrefix("8:00"))
    }
}
