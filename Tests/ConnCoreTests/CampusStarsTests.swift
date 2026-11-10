// Campus stars (S1): the list rules, what is written to settings (addresses and order only, never a title or text), and the feed asking for a starred
// conversation its lists do not carry.
import Testing
import Foundation
import ConnCore
import FakeCampusKit

private func freshDefaults() -> UserDefaults {
    let name = "conn.tests.campusStars.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

private let a = CampusAddress(kind: "private", folder: "default", id: "ses_fakeRates01")
private let b = CampusAddress(kind: "team", folder: "growth-ops", id: "ses_fakeKpi06")
private let c = CampusAddress(kind: "private", folder: "default", id: "ses_fakeSprint03")

@Suite("Campus stars: the list") struct CampusStarListTests {
    @Test func anAddressIsThreePlainParts() {
        #expect(CampusAddress.parse("private/default/ses_fakeRates01") == a)
        #expect(CampusAddress.parse("team/growth-ops/ses_fakeKpi06") == b)
        #expect(a.text == "private/default/ses_fakeRates01" && a.spaceID == "private/default")
        for bad in ["", "ses_fakeRates01", "private/default", "other/default/ses_fakeRates01", "private/../ses_fakeRates01", "private/default/ses", "private/default/ses_x/extra", "private/de fault/ses_fakeRates01", "private//ses_fakeRates01"] {
            #expect(CampusAddress.parse(bad) == nil, "\(bad)")
        }
    }

    @Test func addsInOrderOnceAndRemoves() {
        var l = CampusStarList()
        let added = [l.add(a), l.add(b), l.add(c)]
        let again = l.add(a)                                // already there
        #expect(added == [true, true, true] && !again)
        #expect(l.ids == ["ses_fakeRates01", "ses_fakeKpi06", "ses_fakeSprint03"])
        let removed = l.remove("ses_fakeKpi06"), removedAgain = l.remove("ses_fakeKpi06")
        #expect(removed && !removedAgain)
        #expect(l.ids == ["ses_fakeRates01", "ses_fakeSprint03"] && l.contains("ses_fakeSprint03") && l.address(of: "ses_fakeRates01") == a)
    }

    @Test func aDragTakesThePlaceOfTheTargetAndUnknownIdsChangeNothing() {
        var l = CampusStarList([a, b, c])
        l.move("ses_fakeSprint03", onto: "ses_fakeRates01")
        #expect(l.ids == ["ses_fakeSprint03", "ses_fakeRates01", "ses_fakeKpi06"])
        l.move("ses_fakeSprint03", onto: "ses_fakeKpi06")
        #expect(l.ids == ["ses_fakeRates01", "ses_fakeKpi06", "ses_fakeSprint03"])
        let before = l
        l.move("ses_nope0000", onto: "ses_fakeRates01"); l.move("ses_fakeRates01", onto: "ses_nope0000"); l.move("ses_fakeRates01", onto: "ses_fakeRates01")
        #expect(l == before)
    }

    @Test func theListIsBoundedAndDuplicatesCountOnce() {
        var l = CampusStarList()
        for i in 0..<(CampusStarList.limit + 5) { _ = l.add(CampusAddress(kind: "private", folder: "default", id: "ses_many\(String(format: "%03d", i))")) }
        let overflow = l.add(a)
        #expect(l.entries.count == CampusStarList.limit && !overflow)
        #expect(CampusStarList([a, a, b, a]).ids == ["ses_fakeRates01", "ses_fakeKpi06"])
    }

    @Test func readingSettingsDropsAnythingThatIsNotAnAddress() {
        let l = CampusStarList.parse(["private/default/ses_fakeRates01", "not an address", "", "team/growth-ops/ses_fakeKpi06", "private/default/ses_fakeRates01"])
        #expect(l.ids == ["ses_fakeRates01", "ses_fakeKpi06"] && l.stored == ["private/default/ses_fakeRates01", "team/growth-ops/ses_fakeKpi06"])
    }
}

@Suite("Campus stars: what is kept") @MainActor struct CampusStarStoreTests {
    @Test func theOrderSurvivesARelaunchAndOnlyAddressesAreWritten() {
        let d = freshDefaults()
        let s = CampusStarStore(defaults: d)
        let on = [s.toggle(a), s.toggle(b), s.toggle(c)]
        #expect(on == [true, true, true])
        s.move("ses_fakeSprint03", onto: "ses_fakeRates01")
        let again = CampusStarStore(defaults: d)
        #expect(again.list.ids == ["ses_fakeSprint03", "ses_fakeRates01", "ses_fakeKpi06"])
        // What is on disk is exactly the addresses, in order: no title, no text, no time.
        let raw = d.array(forKey: s.key) as? [String]
        #expect(raw == ["private/default/ses_fakeSprint03", "private/default/ses_fakeRates01", "team/growth-ops/ses_fakeKpi06"])
        // The conversation's title (what the feed knows) is not among the settings: every written value is an address.
        #expect((raw ?? []).allSatisfy { CampusAddress.parse($0) != nil } && !String(describing: d.dictionaryRepresentation()).contains("Compare"))
    }

    @Test func toggleStarsAndUnstarsAndAFullListRefuses() {
        let d = freshDefaults()
        let s = CampusStarStore(defaults: d)
        let first = s.toggle(a)
        #expect(first == true && s.isStarred("ses_fakeRates01"))
        let second = s.toggle(a)
        #expect(second == false && !s.isStarred("ses_fakeRates01"))
        for i in 0..<CampusStarList.limit { let ok = s.toggle(CampusAddress(kind: "private", folder: "default", id: "ses_full\(String(format: "%03d", i))")); #expect(ok) }
        let refused = s.toggle(a)
        #expect(refused == false && !s.isStarred("ses_fakeRates01") && s.entries.count == CampusStarList.limit)   // refused, not added
        s.clear()
        #expect(s.entries.isEmpty && CampusStarStore(defaults: d).entries.isEmpty)
    }

    @Test func aMalformedSettingValueIsIgnored() {
        let d = freshDefaults()
        d.set("not a list", forKey: "conn.campusStars")
        #expect(CampusStarStore(defaults: d).entries.isEmpty)
        d.set(["private/default/ses_fakeRates01", "junk"], forKey: "conn.campusStars")
        #expect(CampusStarStore(defaults: d).list.ids == ["ses_fakeRates01"])
    }
}

@MainActor private func until(_ timeout: Double = 5, _ cond: () -> Bool) async -> Bool {
    // A wall-clock deadline with room: the suites run in parallel and one of them holds the main actor for about 20 s, so counting sleeps of 20 ms
    // (which stretch under that load) gave up before the condition had a turn on the main actor. A passing wait still ends as soon as the condition holds.
    let end = Date().addingTimeInterval(max(timeout, 30))
    while !cond() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
    return cond()
}

@Suite("Campus stars: the feed finds a starred conversation the lists do not carry") @MainActor struct CampusStarFeedTests {
    /// The stand-in with one conversation left out of the list route (what a space with more than 50 recent ones does to an older one); a direct read still finds it.
    private func store(hiding hidden: String) async -> (CampusStore, FakeCampusAuth) {
        let world = FakeCampusWorld()
        let auth = FakeCampusAuth(world: world)
        auth.override = { r in
            guard r.path.contains("/conversations?limit=") else { return nil }
            let real = world.route(method: "GET", path: r.path, cookie: nil, body: nil)
            guard var o = (try? JSONSerialization.jsonObject(with: real.body)) as? [String: Any], var list = o["conversations"] as? [[String: Any]] else { return nil }
            list.removeAll { ($0["id"] as? String) == hidden }
            o["conversations"] = list
            return CampusReply(status: 200, body: (try? JSONSerialization.data(withJSONObject: o)) ?? Data())
        }
        let s = CampusStore(auth: auth, baseURL: URL(string: "https://campus.example.test")!)
        s.statusDelay = 0.02
        return (s, auth)
    }

    @Test func withoutAStarTheHiddenOneIsNotInTheRows() async {
        let (s, _) = await store(hiding: "ses_fakeOffsite04")
        await s.refresh()
        #expect(s.conversation("ses_fakeOffsite04") == nil && s.conversations.count == 7)
    }

    @Test func aStarredOneIsAskedForByItsAddressWithItsTitleAndState() async {
        let (s, _) = await store(hiding: "ses_fakeOffsite04")
        s.starAddresses = [CampusAddress(kind: "private", folder: "default", id: "ses_fakeOffsite04")]
        await s.refresh()
        let row = s.conversation("ses_fakeOffsite04")
        #expect(row?.title == "Plan the Q1 offsite agenda" && row?.spaceName == "My space" && row?.state == .idle && s.conversations.count == 8)
        // Still there on the next read, and a conversation Campus has really lost (a 404) is not invented.
        await s.refresh()
        #expect(s.conversation("ses_fakeOffsite04") != nil)
        s.starAddresses = [CampusAddress(kind: "private", folder: "default", id: "ses_goneForever")]
        await s.refresh()
        #expect(s.conversation("ses_goneForever") == nil)
    }

    @Test func aStarInASpaceThatDidNotAnswerKeepsWhatWasKnown() async {
        let (s, auth) = await store(hiding: "ses_nothingHidden")
        s.starAddresses = [CampusAddress(kind: "team", folder: "growth-ops", id: "ses_fakeKpi06")]
        await s.refresh()
        #expect(s.conversation("ses_fakeKpi06") != nil)
        auth.offline = true
        await s.refresh()
        #expect(s.conversation("ses_fakeKpi06") != nil)         // nothing lost while Campus is away
    }
}
