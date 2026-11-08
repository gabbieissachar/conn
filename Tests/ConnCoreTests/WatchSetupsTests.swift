import Testing
import Foundation
import ConnCore

@Suite("Watch column setups: the last one per count, and presets") struct WatchSetupsTests {
    let a = "aaaaaaaa-0000-4000-8000-000000000001"
    let b = "bbbbbbbb-0000-4000-8000-000000000002"
    let c = "cccccccc-0000-4000-8000-000000000003"
    let d = "dddddddd-0000-4000-8000-000000000004"
    let e = "eeeeeeee-0000-4000-8000-000000000005"

    func setup(_ cols: String?...) -> WatchSetup { WatchSetup(columns: cols) }

    // MARK: a setup and a layout

    @Test func aLayoutKnowsItsSetupInColumnOrder() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        w.close(1)
        #expect(w.setup == setup(a, nil, c))
        #expect(w.setup.count == 3)
        #expect(w.setup.sessions == [a, c])
    }

    @Test func applyingASetupPutsEverySessionInItsOwnColumnAndSetsTheCount() {
        var w = WatchLayout(count: 3)
        w.open(d); w.open(e)
        let gone = w.apply(setup(a, b, nil, c))
        #expect(gone.isEmpty)
        #expect(w.count == 4)
        #expect(w.slots.map { $0?.session } == [a, b, nil, c])
        #expect(w.setup == setup(a, b, nil, c))
    }

    @Test func aColumnThatKeepsItsSessionInItsPlaceKeepsItsIdentityAndTheOthersAreNew() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        let ids = w.slots.map { $0!.id }
        w.apply(setup(a, d, c))
        #expect(w.slots[0]!.id == ids[0])          // same session, same place: its web view stays
        #expect(w.slots[2]!.id == ids[2])
        #expect(w.slots[1]!.id != ids[1])          // another session: a column of its own
        #expect(Set(w.slots.compactMap { $0?.id }).count == 3)
    }

    @Test func aSessionThatMovedToAnotherColumnIsANewColumnNotTheOldOne() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        let ids = w.slots.map { $0!.id }
        w.apply(setup(b, a, c))
        #expect(w.slots[0]!.id != ids[0] && w.slots[0]!.id != ids[1])
        #expect(w.slots[1]!.id != ids[0] && w.slots[1]!.id != ids[1])
        #expect(w.slots[2]!.id == ids[2])
    }

    @Test func aSessionThatIsGoneLeavesItsColumnFreeAndIsReported() {
        var w = WatchLayout(count: 3)
        let gone = w.apply(setup(a, b, c), isGone: { $0 == b })
        #expect(gone == [b])
        #expect(w.slots.map { $0?.session } == [a, nil, c])
        // The normal fill rule takes the free column.
        #expect(w.fill(with: [d]) == [1])
        #expect(w.setup == setup(a, d, c))
    }

    @Test func restoredColumnsCountAsUsedFromLeftToRightSoTheLeftmostIsReplacedFirst() {
        var w = WatchLayout(restoring: setup(a, b, c))
        #expect(w.leastRecentlyUsed == 0)
        #expect(w.open(d) == .replaced(column: 0, previous: a))
        #expect(w.setup == setup(d, b, c))
    }

    @Test func aSetupWithAnUnsupportedNumberOfColumnsIsNotApplied() {
        var w = WatchLayout(count: 3)
        w.open(a)
        #expect(w.apply(setup(b)).isEmpty)
        #expect(w.apply(WatchSetup(columns: [nil, nil, nil, nil, nil])).isEmpty)
        #expect(w.setup == setup(a, nil, nil))
    }

    @Test func aSessionNamedTwiceInASetupKeepsOnlyItsFirstColumn() {
        var w = WatchLayout(count: 3)
        w.apply(setup(a, b, String(a.prefix(8))))
        #expect(w.setup == setup(a, b, nil))
    }

    // MARK: the last setup of each count

    @Test func eachColumnCountKeepsItsOwnLastSetup() {
        var s = WatchSetups()
        #expect(s.last(forCount: 3) == nil)
        let r1 = s.remember(setup(a, b, c)), r2 = s.remember(setup(d, e))
        #expect(r1 && r2)
        #expect(s.last(forCount: 3) == setup(a, b, c))
        #expect(s.last(forCount: 2) == setup(d, e))
        #expect(s.last(forCount: 4) == nil)
        let same = s.remember(setup(d, e))          // nothing changed
        let newer = s.remember(setup(d, nil))       // a newer one for the same count replaces it
        #expect(!same && newer)
        #expect(s.last(forCount: 2) == setup(d, nil))
    }

    @Test func threeToTwoToThreeBringsTheThreeColumnSetupBack() {
        // What the model does on a change of count: remember what is being left, then apply the count's last setup (or shrink as before).
        var s = WatchSetups()
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        func choose(_ n: Int) {
            s.remember(w.setup)
            if let last = s.last(forCount: n), !last.isEmpty { w.apply(last) } else { w.setCount(n) }
            s.remember(w.setup)
        }
        choose(2)
        #expect(w.count == 2 && w.sessions.count == 2)          // never used: the shrink keeps the most recent two, as before
        choose(3)
        #expect(w.setup == setup(a, b, c))
        choose(2)
        w.open(d)                                               // the person changes the two-column setup
        let two = w.setup
        choose(3)
        #expect(w.setup == setup(a, b, c))
        choose(2)
        #expect(w.setup == two)
    }

    // MARK: presets

    @Test func savingAPresetKeepsTheNameAndTheSetup() {
        var s = WatchSetups()
        guard case .saved(let p) = s.savePreset(name: "  Morning   leaders ", setup: setup(a, nil, c), makeID: { "p1" }) else { Issue.record("not saved"); return }
        #expect(p.id == "p1" && p.name == "Morning leaders" && p.setup == setup(a, nil, c))
        #expect(s.presets == [p])
        #expect(s.preset(id: "p1") == p)
    }

    @Test func aNameIsCutAndAnEmptyOneRefused() {
        #expect(WatchSetups.cleanName("   \n ") == nil)
        #expect(WatchSetups.cleanName(String(repeating: "x", count: 100))?.count == WatchSetups.maxNameLength)
        var s = WatchSetups()
        #expect(s.savePreset(name: " ", setup: setup(a, b)) == .refused(.emptyName))
        #expect(s.presets.isEmpty)
    }

    @Test func aSetupWithNoConversationIsNotWorthSaving() {
        var s = WatchSetups()
        #expect(s.savePreset(name: "Empty", setup: setup(nil, nil, nil)) == .refused(.nothingToSave))
    }

    @Test func theSameNameReplacesThePresetInPlaceWhateverTheCapitals() {
        var s = WatchSetups()
        var n = 0
        func id() -> String { n += 1; return "id\(n)" }
        s.savePreset(name: "Review", setup: setup(a, b), makeID: id)
        s.savePreset(name: "Other", setup: setup(c, d), makeID: id)
        guard case .replaced(let p) = s.savePreset(name: "REVIEW", setup: setup(d, e, a), makeID: id) else { Issue.record("not replaced"); return }
        #expect(p.id == "id1" && p.name == "REVIEW" && p.setup == setup(d, e, a))
        #expect(s.presets.map(\.name) == ["REVIEW", "Other"])
    }

    @Test func thereIsALimitToHowManyPresetsAreKept() {
        var s = WatchSetups()
        for i in 0..<WatchSetups.maxPresets { s.savePreset(name: "P\(i)", setup: setup(a, b)) }
        #expect(s.presets.count == WatchSetups.maxPresets)
        #expect(s.savePreset(name: "One more", setup: setup(a, b)) == .refused(.tooMany))
        #expect(s.savePreset(name: "p3", setup: setup(c, d)) != .refused(.tooMany))      // replacing one is not adding
    }

    @Test func renamingKeepsTheSetupAndRefusesAnEmptyOrTakenName() {
        var s = WatchSetups()
        s.savePreset(name: "One", setup: setup(a, b), makeID: { "1" })
        s.savePreset(name: "Two", setup: setup(c, d), makeID: { "2" })
        #expect(s.renamePreset(id: "1", to: "  Uno ") == nil)
        #expect(s.preset(id: "1")?.name == "Uno" && s.preset(id: "1")?.setup == setup(a, b))
        #expect(s.renamePreset(id: "1", to: "two") == .nameTaken)
        #expect(s.renamePreset(id: "1", to: "  ") == .emptyName)
        #expect(s.renamePreset(id: "9", to: "Nine") == .unknownPreset)
        #expect(s.renamePreset(id: "1", to: "UNO") == nil)         // only the capitals of its own name
        #expect(s.preset(id: "1")?.name == "UNO")
    }

    @Test func deletingAPresetRemovesOnlyThatOne() {
        var s = WatchSetups()
        s.savePreset(name: "One", setup: setup(a, b), makeID: { "1" })
        s.savePreset(name: "Two", setup: setup(c, d), makeID: { "2" })
        let first = s.deletePreset(id: "1"), again = s.deletePreset(id: "1")
        #expect(first && !again)
        #expect(s.presets.map(\.id) == ["2"])
    }

    @Test func loadingAPresetSetsTheCountAndEveryColumn() {
        var s = WatchSetups()
        s.savePreset(name: "Four", setup: setup(a, b, nil, d), makeID: { "4" })
        var w = WatchLayout(count: 2)
        w.open(e)
        w.apply(s.preset(id: "4")!.setup)
        #expect(w.count == 4 && w.setup == setup(a, b, nil, d))
    }

    // MARK: what the settings hold

    @Test func theSettingsRoundTripAndHoldOnlySessionIds() throws {
        var s = WatchSetups()
        s.remember(setup(a, b, c))
        s.remember(setup(d, nil))
        s.savePreset(name: "Mine", setup: setup(a, nil, c, e), makeID: { "m" })
        let data = try #require(s.encoded())
        #expect(WatchSetups.decode(data) == s)
        let text = String(decoding: data, as: UTF8.self)
        // Only what the person chose to keep: ids, order, and a preset's name.
        for id in [a, b, c, d, e] { #expect(text.contains(id)) }
        #expect(text.contains("Mine"))
    }

    @Test func campusConversationsAreKeptByTheirKeyToo() throws {
        var s = WatchSetups()
        let k = CampusColumn.key("ses_fakeKpi06")
        s.remember(setup(a, k))
        #expect(WatchSetups.decode(s.encoded()).last(forCount: 2) == setup(a, k))
        var w = WatchLayout(count: 2)
        #expect(w.apply(setup(a, k), isGone: { CampusColumn.isCampus($0) }) == [k])
        #expect(w.setup == setup(a, nil))
    }

    @Test func readingBadBytesGivesAnEmptyValue() {
        #expect(WatchSetups.decode(nil) == WatchSetups())
        #expect(WatchSetups.decode(Data("not json".utf8)) == WatchSetups())
        #expect(WatchSetups.decode(Data("{}".utf8)) == WatchSetups())
        #expect(WatchSetups.decode(Data("[1,2]".utf8)) == WatchSetups())
    }

    @Test func entriesThatAreNotValidAreDroppedWhenReadBack() {
        let json = """
        {"version":1,
         "lastByCount":{
           "3":{"columns":["\(a)","has space",null]},
           "2":{"columns":["\(a)","\(b)","\(c)"]},
           "9":{"columns":["\(a)","\(b)"]},
           "4":{"columns":["\(a)","\(a)","\(b)","<script>"]}},
         "presets":[
           {"id":"1","name":"Good","setup":{"columns":["\(a)","\(b)"]}},
           {"id":"2","name":"   ","setup":{"columns":["\(a)","\(b)"]}},
           {"id":"3","name":"good","setup":{"columns":["\(c)","\(d)"]}},
           {"id":"1","name":"Same id","setup":{"columns":["\(c)","\(d)"]}},
           {"id":"4","name":"One column","setup":{"columns":["\(a)"]}}]}
        """
        let s = WatchSetups.decode(Data(json.utf8))
        #expect(s.last(forCount: 3) == setup(a, nil, nil))                 // a session that is not valid is left out
        #expect(s.last(forCount: 2) == nil)                                // kept under the wrong count
        #expect(s.last(forCount: 4) == setup(a, nil, b, nil))              // a session twice stays in its first column
        #expect(s.presets.map(\.name) == ["Good"])                          // no name, name taken, id taken, wrong number of columns
    }
}

@Suite("Watch column setups: which remembered sessions are gone") struct WatchSetupsGoneTests {
    let a = "aaaaaaaa-0000-4000-8000-000000000001"

    @Test func aMalformedIdIsGoneAndAWellFormedReaderIdIsNot() {
        #expect(WatchSetup.isGone("has space", campusKnown: false, campusHas: { _ in true }))
        #expect(WatchSetup.isGone("", campusKnown: false, campusHas: { _ in true }))
        #expect(!WatchSetup.isGone(a, campusKnown: false, campusHas: { _ in false }))
    }

    @Test func aCampusConversationIsGoneOnlyWhenTheFeedIsKnownAndDoesNotListIt() {
        let key = CampusColumn.key("ses_fakeKpi06")
        #expect(WatchSetup.isGone(key, campusKnown: true, campusHas: { _ in false }))
        #expect(!WatchSetup.isGone(key, campusKnown: true, campusHas: { $0 == "ses_fakeKpi06" }))
        #expect(!WatchSetup.isGone(key, campusKnown: false, campusHas: { _ in false }))      // signed out or not answered yet: never judged gone
    }
}
