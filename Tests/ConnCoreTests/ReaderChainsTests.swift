import Testing
import Foundation
@testable import ConnCore

@Suite("Reader session chains") struct ReaderChainsTests {
    private let old = "2fc58244-40de-4a63-929f-d7ac852bbbdb", mid = "5c4c926e-dd8c-4cc2-88a3-744bc08c177f", cur = "954fe0d3-8852-418c-b7bb-0e6555806aa4"
    private let other = "1b1c638b-ec05-4e5b-946a-a7d26f470efc"

    private func feed(_ convs: [[String: Any]]) -> Data { try! JSONSerialization.data(withJSONObject: ["version": 1, "conversations": convs]) }

    @Test func twoIdsOfOneChainAreOneConversationAndTwoChainsAreNot() {
        let c = ReaderChains.parse(feed([["id": cur, "ids": [old, mid, cur]], ["id": other, "ids": ["aaaaaaaa-0000-4000-8000-000000000001", other]]]))
        #expect(c.same(old, cur) && c.same(mid, old) && c.same(cur, mid))
        #expect(!c.same(old, other) && !c.same(cur, other))
        #expect(c.count == 2)
    }

    @Test func theReadersEightCharacterAddressesAreTold() {
        let c = ReaderChains.parse(feed([["id": cur, "ids": [old, cur]]]))
        #expect(c.same("2fc58244", cur) && c.same(old, "954fe0d3") && c.same("2fc58244", "954fe0d3"))
        #expect(!c.same("2fc5824", cur))                          // fewer than eight characters only match themselves
    }

    @Test func idsThatOnlyShareTheirFirstEightCharactersAreNotMerged() {
        let a = "00000000-0000-4000-8000-000000000001", a0 = "0a1d0000-0000-4000-8000-000000000001"
        let b = "00000000-0000-4000-8000-000000000002", b0 = "0a1d0000-0000-4000-8000-000000000002"
        let c = ReaderChains.parse(feed([["id": a, "ids": [a0, a]], ["id": b, "ids": [b0, b]]]))
        #expect(c.same(a0, a) && c.same(b0, b))
        #expect(!c.same(a, b) && !c.same(a0, b) && !c.same(a, b0))
        #expect(c.same("00000000", a))                            // an eight-character address of an id still reads as that id (WatchLayout.same)
        #expect(!c.same("0a1d0000", b))                           // but an address that starts ids of two chains names neither
    }

    @Test func withoutAChainIdsMatchAsBefore() {
        let none = ReaderChains()
        #expect(none.same(cur, cur) && none.same(cur, "954fe0d3"))
        #expect(!none.same(old, cur))
        #expect(!none.same("", ""))
    }

    @Test func anIdThatIsNotInTheListedIdsStillJoinsItsChain() {
        let c = ReaderChains.parse(feed([["id": cur, "ids": [old, mid]]]))
        #expect(c.same(old, cur) && c.same(mid, cur))
    }

    @Test func aFeedThatIsNotOneGivesNoChainsAndNeverFails() {
        for bad in ["", "not json", "[]", "{\"conversations\": 3}", "{\"conversations\": [{\"id\": 5, \"ids\": \"x\"}]}"] {
            let c = ReaderChains.parse(Data(bad.utf8))
            #expect(c.count == 0 && !c.same(old, cur))
        }
    }

    @Test func aConversationWithOneIdMakesNoChain() {
        let c = ReaderChains.parse(feed([["id": cur, "ids": [cur]]]))
        #expect(c.count == 0)
    }

    @Test func theDefaultFileIsTheReadersGlanceFeedUnlessTheEnvironmentNamesAnother() {
        #expect(ReaderChains.defaultFile(env: [:], home: "/h").path == "/h/workspace/pmos/setup/transcript-reader/out/glance.json")
        #expect(ReaderChains.defaultFile(env: ["CONN_READER_GLANCE": "/x/g.json"], home: "/h").path == "/x/g.json")
    }
}
