import Testing
import Foundation
import HelmCore

@Suite("Reader stars: reading the star list, ordering, persistence") struct ReaderStarsTests {
    func file(_ json: String) -> Data { json.data(using: .utf8)! }

    // MARK: the reader's star list

    @Test func theReadersFileIsReadInItsOwnOrder() {
        let stars = ReaderStars.parse(file(#"{"version":1,"rev":8,"stars":[{"conv":"b2","starred":2.5},{"conv":"a1","starred":1}]}"#))
        #expect(stars?.map(\.conv) == ["b2", "a1"])
        #expect(stars?.first?.starred == 2.5)
    }

    @Test func entriesTheReaderWouldRejectAreDroppedAndRepeatsCountOnce() {
        let stars = ReaderStars.parse(file(#"{"rev":1,"stars":[{"conv":"ok-1","starred":1},{"conv":"has space","starred":1},{"conv":"ok-1","starred":9},{"conv":"no-time"},{"starred":3},"text",{"conv":"","starred":1}]}"#))
        #expect(stars?.map(\.conv) == ["ok-1"])
    }

    @Test func aFileThatIsNotAStarListGivesNoNewsRatherThanAnEmptyRow() {
        #expect(ReaderStars.parse(file("not json")) == nil)
        #expect(ReaderStars.parse(file(#"{"rev":1}"#)) == nil)
        #expect(ReaderStars.parse(file(#"{"stars":[]}"#)) == nil)            // no revision: not the reader's file
        #expect(ReaderStars.parse(file(#"{"rev":0,"stars":[]}"#)) == [])
    }

    @Test func aMissingFileMeansNothingIsStarredAndAnUnreadableOneIsNoNews() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("helm-stars-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        #expect(ReaderStars.read(dir.appendingPathComponent("stars.json")) == [])
        let bad = dir.appendingPathComponent("bad.json")
        try "{".write(to: bad, atomically: true, encoding: .utf8)
        #expect(ReaderStars.read(bad) == nil)
        let good = dir.appendingPathComponent("good.json")
        try #"{"version":1,"rev":2,"stars":[{"conv":"x1","starred":1}]}"#.write(to: good, atomically: true, encoding: .utf8)
        #expect(ReaderStars.read(good)?.map(\.conv) == ["x1"])
    }

    @Test func theFileComesFromTheEnvironmentOrTheReadersDefault() {
        #expect(ReaderStars.defaultFile(env: [:], home: "/h").path == "/h/.config/pmos-transcript-reader/stars.json")
        #expect(ReaderStars.defaultFile(env: ["PMOS_READER_STARS": "/x/s.json"], home: "/h").path == "/x/s.json")
        #expect(ReaderStars.defaultFile(env: ["HELM_READER_STARS": "/y/s.json", "PMOS_READER_STARS": "/x/s.json"], home: "/h").path == "/y/s.json")
    }

    // MARK: the order

    @Test func withNoSavedOrderTheChipsFollowTheReader() {
        #expect(StarOrder.arrange(stars: ["a", "b", "c"], saved: []) == ["a", "b", "c"])
    }

    @Test func aSavedOrderWinsAndANewStarJoinsAtTheEnd() {
        #expect(StarOrder.arrange(stars: ["a", "b", "c", "d"], saved: ["c", "a", "b"]) == ["c", "a", "b", "d"])
        #expect(StarOrder.arrange(stars: ["a", "b", "c", "d", "e"], saved: ["c", "a"]) == ["c", "a", "b", "d", "e"])
    }

    @Test func aStarRemovedInTheReaderLeavesTheRowAndComesBackToItsPlace() {
        let saved = ["c", "a", "b"]
        #expect(StarOrder.arrange(stars: ["a", "b"], saved: saved) == ["a", "b"])
        #expect(StarOrder.arrange(stars: ["a", "b", "c"], saved: saved) == ["c", "a", "b"])   // saved is not edited by arranging
    }

    @Test func repeatedIdsInTheSavedOrderCountOnce() {
        #expect(StarOrder.arrange(stars: ["a", "b"], saved: ["b", "b", "a", "z"]) == ["b", "a"])
    }

    @Test func aDropTakesThePlaceOfTheChipItLandsOn() {
        let o = ["a", "b", "c", "d"]
        #expect(StarOrder.moved(o, "d", onto: "a") == ["d", "a", "b", "c"])     // from the right: before it
        #expect(StarOrder.moved(o, "a", onto: "c") == ["b", "c", "a", "d"])     // from the left: after it
        #expect(StarOrder.moved(o, "b", onto: "c") == ["a", "c", "b", "d"])     // neighbours swap
        #expect(StarOrder.moved(o, "c", onto: "c") == o)
        #expect(StarOrder.moved(o, "x", onto: "c") == o)
        #expect(StarOrder.moved(o, "a", onto: "x") == o)
    }

    // MARK: persistence

    @Test func theOrderSurvivesARelaunch() throws {
        let name = "dev.local.helm.test.stars.\(UUID().uuidString)"
        let first = try #require(UserDefaults(suiteName: name))
        defer { first.removePersistentDomain(forName: name) }
        #expect(StarOrderStore(defaults: first).order == [])
        StarOrderStore(defaults: first).order = StarOrder.moved(["a", "b", "c"], "c", onto: "a")
        // A second launch reads the same domain with a new store (and a new defaults object).
        let second = try #require(UserDefaults(suiteName: name))
        let saved = StarOrderStore(defaults: second).order
        #expect(saved == ["c", "a", "b"])
        #expect(StarOrder.arrange(stars: ["a", "b", "c", "n"], saved: saved) == ["c", "a", "b", "n"])
    }

    @Test func aSavedValueThatIsNotAnIdListIsIgnored() throws {
        let name = "dev.local.helm.test.stars.\(UUID().uuidString)"
        let d = try #require(UserDefaults(suiteName: name))
        defer { d.removePersistentDomain(forName: name) }
        d.set("nonsense", forKey: "helm.readerStarOrder")
        #expect(StarOrderStore(defaults: d).order == [])
        d.set(["ok-1", "bad id", 5] as [Any], forKey: "helm.readerStarOrder")
        #expect(StarOrderStore(defaults: d).order == [])      // the array is not all strings: nothing is trusted
        d.set(["ok-1", "bad id"], forKey: "helm.readerStarOrder")
        #expect(StarOrderStore(defaults: d).order == ["ok-1"])
    }

    // MARK: names and the chip on screen

    @Test func aStarIsNamedByItsAgentThenTheReadersRecordThenItsId() {
        let conv = "3c2655a9-1111-2222-3333-444444444444"
        #expect(StarLabels.resolve(conv: conv, agentNames: [conv: "esim-BC-49-PRD"], recorded: [conv: "old name"]) == "esim-BC-49-PRD")
        #expect(StarLabels.resolve(conv: conv, agentNames: [:], recorded: [conv: "old name"]) == "old name")
        #expect(StarLabels.resolve(conv: conv, agentNames: [conv: ""], recorded: [:]) == "3c2655a9")
    }

    @Test func theReadersPaneLabelsAreReadAndJunkIsIgnored() {
        let t = StarLabels.parse(file(#"{"a1":{"herdr":"esim","label":"fm-one","title":"t"},"b2":{"label":"  "},"c3":{"title":"no label"},"d4":"x"}"#))
        #expect(t == ["a1": "fm-one"])
        #expect(StarLabels.parse(file("[1]")) == [:])
    }

    @Test func theChipOnScreenIsTheOneTheAddressNames() {
        let a = "3c2655a9-1111-2222-3333-444444444444", b = "5dba1ebd-1111-2222-3333-444444444444"
        // The reader rewrites its address to the first eight characters of the session id.
        let shown = StarSelection.sessionPrefix(inFragment: "s=5dba1ebd")
        #expect(shown == "5dba1ebd")
        #expect(StarSelection.selected(convs: [a, b], shown: shown) == b)
        // Helm's own pin carries the whole id.
        #expect(StarSelection.selected(convs: [a, b], shown: StarSelection.sessionPrefix(inFragment: "s=\(a)")) == a)
        #expect(StarSelection.sessionPrefix(inFragment: "s=5dba1ebd&d=0123456789") == "5dba1ebd")
        #expect(StarSelection.selected(convs: [a, b], shown: nil) == nil)
        #expect(StarSelection.selected(convs: [a, b], shown: StarSelection.sessionPrefix(inFragment: "q=1")) == nil)
        #expect(StarSelection.selected(convs: [a, b], shown: "") == nil)
    }
}
