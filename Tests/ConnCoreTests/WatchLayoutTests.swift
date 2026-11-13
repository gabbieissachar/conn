import Testing
import Foundation
import ConnCore

@Suite("Watch columns: which column a session goes to") struct WatchLayoutTests {
    // Session ids are long enough (8 characters or more) to be told apart by prefix, as real ones are.
    let a = "aaaaaaaa-0000-4000-8000-000000000001"
    let b = "bbbbbbbb-0000-4000-8000-000000000002"
    let c = "cccccccc-0000-4000-8000-000000000003"
    let d = "dddddddd-0000-4000-8000-000000000004"
    let e = "eeeeeeee-0000-4000-8000-000000000005"

    // MARK: free slot

    @Test func aNewSessionTakesTheFirstFreeColumn() {
        var w = WatchLayout(count: 3)
        #expect(w.open(a) == .freeSlot(column: 0))
        #expect(w.open(b) == .freeSlot(column: 1))
        #expect(w.sessions == [a, b])
        #expect(w.slots[2] == nil)
    }

    @Test func aClosedColumnIsTheNextFreeOneAndTheOthersStayPut() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        #expect(w.close(1) == b)
        #expect(w.sessions == [a, c])
        #expect(w.slots[1] == nil)
        #expect(w.open(d) == .freeSlot(column: 1))
        #expect(w.slots.map { $0?.session } == [a, d, c])
    }

    @Test func aFreeColumnIsUsedBeforeAnyColumnIsReplaced() {
        var w = WatchLayout(count: 4)
        w.open(a); w.open(b); w.open(c)
        w.touch(0)                                   // a is the most recent, b the oldest
        #expect(w.open(d) == .freeSlot(column: 3))   // not b's place
        #expect(w.sessions == [a, b, c, d])
    }

    // MARK: already open

    @Test func aSessionThatIsOpenKeepsItsColumnAndNothingElseMoves() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        let before = w.slots.map { $0?.session }
        #expect(w.open(b) == .alreadyOpen(column: 1))
        #expect(w.slots.map { $0?.session } == before)
        #expect(w.openCount == 3)
    }

    @Test func openingASessionAgainCountsAsUsingItsColumn() {
        var w = WatchLayout(count: 2)
        w.open(a); w.open(b)
        #expect(w.leastRecentlyUsed == 0)
        w.open(a)
        #expect(w.leastRecentlyUsed == 1)
    }

    @Test func anIdIsTheSameSessionWhenOneIsTheStartOfTheOther() {
        var w = WatchLayout(count: 3)
        w.open(a)
        #expect(w.open(String(a.prefix(8))) == .alreadyOpen(column: 0))    // the reader's own short form
        #expect(w.index(of: a) == 0)
        // Different sessions that merely share a few leading characters are not the same, and short ids only match themselves.
        #expect(!WatchLayout.same("abcd", "abcdef"))
        #expect(WatchLayout.same("abcd", "abcd"))
        #expect(!WatchLayout.same("aaaaaaaa-1", "aaaaaaab-1"))
        #expect(!WatchLayout.same("", ""))
    }

    // MARK: least recently used replacement

    @Test func whenEveryColumnIsTakenTheLeastRecentlyUsedOneIsReplacedInPlace() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)              // a is the oldest
        let idsBefore = w.slots.map { $0?.id }
        #expect(w.open(d) == .replaced(column: 0, previous: a))
        #expect(w.slots.map { $0?.session } == [d, b, c])
        #expect(w.slots.map { $0?.id } == idsBefore, "the column is kept, so its web view is too")
    }

    @Test func useMovesTheReplacementToTheNextColumn() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        w.touch(0)                                   // click, scroll, key or focus in the first column
        #expect(w.leastRecentlyUsed == 1)
        #expect(w.open(d) == .replaced(column: 1, previous: b))
        w.touch(2)
        #expect(w.open(e) == .replaced(column: 0, previous: a), "a (touched earlier) is now older than d and c")
        #expect(w.sessions == [e, d, c])
    }

    @Test func aTouchOnAFreeOrMissingColumnIsIgnored() {
        var w = WatchLayout(count: 3)
        w.open(a)
        w.touch(2); w.touch(7); w.touch(-1)
        #expect(w.sessions == [a])
    }

    @Test func aReplacedSessionComesBackThroughTheSameRule() {
        var w = WatchLayout(count: 2)
        w.open(a); w.open(b); w.open(c)              // c replaced a
        #expect(w.sessions == [c, b])
        #expect(w.open(a) == .replaced(column: 1, previous: b), "b is now the oldest")
    }

    // MARK: the number of columns

    @Test func theCountIsHeldToTwoThroughFour() {
        #expect(WatchLayout(count: 0).count == 2)
        #expect(WatchLayout(count: 9).count == 4)
        #expect(WatchLayout(count: -3).count == 2)
        #expect(WatchLayout().count == 3)
        #expect(WatchLayout.clamped(5) == 4)
    }

    @Test func moreColumnsAddFreeOnesOnTheRight() {
        var w = WatchLayout(count: 2)
        w.open(a); w.open(b)
        #expect(w.setCount(4).isEmpty)
        #expect(w.slots.map { $0?.session } == [a, b, nil, nil])
        #expect(w.open(c) == .freeSlot(column: 2))
    }

    @Test func fewerColumnsKeepTheMostRecentlyUsedSessionsInOrderAndSayWhatWentAway() {
        var w = WatchLayout(count: 4)
        w.open(a); w.open(b); w.open(c); w.open(d)
        w.touch(0); w.touch(3)                       // used last: a, d
        let dropped = w.setCount(2)
        #expect(Set(dropped) == [b, c])
        #expect(w.sessions == [a, d])
    }

    @Test func fewerColumnsCloseGapsWithoutLosingAnyone() {
        var w = WatchLayout(count: 4)
        w.open(a); w.open(b); w.open(c); w.open(d)
        w.close(0); w.close(1)
        #expect(w.setCount(3).isEmpty)
        #expect(w.slots.map { $0?.session } == [c, d, nil])
    }

    // MARK: filling the columns when Watch opens

    @Test func fillTakesTheFreeColumnsInOrderAndTheFirstCandidateIsTheMostRecent() {
        var w = WatchLayout(count: 3)
        let filled = w.fill(with: [a, b, c, d])
        #expect(filled == [0, 1, 2])
        #expect(w.sessions == [a, b, c])
        #expect(w.leastRecentlyUsed == 2, "the one being looked at is kept longest")
        #expect(w.open(d) == .replaced(column: 2, previous: c))
    }

    @Test func fillSkipsWhatIsOpenAndRepeatsAndStopsWhenTheColumnsAreFull() {
        var w = WatchLayout(count: 3)
        w.open(b)
        let filled = w.fill(with: [b, a, a, String(a.prefix(8)), c, d])
        #expect(filled == [1, 2])
        #expect(w.slots.map { $0?.session } == [b, a, c])
        #expect(w.fill(with: [d]).isEmpty)
    }

    // MARK: a session link clicked inside a column

    @Test func aLinkToASessionThatIsOpenKeepsItsColumnAndNothingElseMoves() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        let before = w.slots.map { $0?.session }
        #expect(w.open(c, from: 0) == .alreadyOpen(column: 2))
        #expect(w.slots.map { $0?.session } == before)
    }

    @Test func aLinkToTheSessionOfItsOwnColumnChangesNothing() {
        var w = WatchLayout(count: 2)
        w.open(a); w.open(b)
        #expect(w.open(a, from: 0) == .alreadyOpen(column: 0))
        #expect(w.sessions == [a, b])
    }

    @Test func aLinkUsesAFreeColumnBeforeReplacingAny() {
        var w = WatchLayout(count: 4)
        w.open(a); w.open(b); w.open(c)
        #expect(w.open(d, from: 0) == .freeSlot(column: 3))
        #expect(w.sessions == [a, b, c, d])
    }

    @Test func aLinkReplacesTheLeastRecentlyUsedColumnOtherThanTheOneClicked() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)        // a is the least recently used
        #expect(w.leastRecentlyUsed == 0)
        #expect(w.open(d, from: 0) == .replaced(column: 1, previous: b))   // the clicked column is spared, b is next oldest
        #expect(w.slots.map { $0?.session } == [a, d, c])
    }

    @Test func theClickedColumnCountsAsUsedEvenWhenTheLinkChangesNothingElse() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        #expect(w.open(d, from: 0) == .replaced(column: 1, previous: b))
        // The click made column 0 the most recent use before d took column 1, so c is now the oldest.
        #expect(w.leastRecentlyUsed == 2)
    }

    @Test func aLinkInAnyColumnNeverRemovesItsOwnPage() {
        for clicked in 0..<2 {
            var w = WatchLayout(count: 2)
            w.open(a); w.open(b)
            let own = w.slots[clicked]!.session
            let p = w.open(c, from: clicked)
            #expect(p.column == 1 - clicked)
            #expect(w.slots[clicked]!.session == own)
        }
    }

    @Test func aClickInAColumnThatDoesNotExistFallsBackToTheOrdinaryRule() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        #expect(w.open(d, from: 7) == .replaced(column: 0, previous: a))
        var x = WatchLayout(count: 3)
        x.open(a); x.open(b)
        #expect(x.open(c, from: 2) == .freeSlot(column: 2))     // an empty column was not clicked
    }

    @Test func leastRecentlyUsedCanLeaveOneColumnOut() {
        var w = WatchLayout(count: 3)
        w.open(a); w.open(b); w.open(c)
        #expect(w.leastRecentlyUsed(excluding: nil) == 0)
        #expect(w.leastRecentlyUsed(excluding: 0) == 1)
        #expect(w.leastRecentlyUsed(excluding: 1) == 0)
        var one = WatchLayout(count: 2)
        one.open(a)
        #expect(one.leastRecentlyUsed(excluding: 0) == nil)
    }

    // MARK: addresses on the lite page

    @Test func theAddressNamesTheSessionAndOptionallyTheAskingTurn() {
        #expect(WatchAddress.fragment(session: a, message: nil) == "s=\(a)")
        #expect(WatchAddress.fragment(session: a, message: "t12ad57c7c69734480c8aaddb") == "s=\(a)&m=t12ad57c7c69734480c8aaddb")
    }

    @Test func aTurnIdThePageWouldRefuseIsLeftOffAndASessionItCannotOpenGivesNothing() {
        #expect(WatchAddress.fragment(session: a, message: "short") == "s=\(a)")
        #expect(WatchAddress.fragment(session: a, message: "has space in it") == "s=\(a)")
        #expect(WatchAddress.fragment(session: a, message: "x';alert(1);'") == "s=\(a)")
        #expect(WatchAddress.fragment(session: "a b", message: nil) == nil)
        #expect(WatchAddress.fragment(session: "", message: nil) == nil)
        #expect(WatchAddress.fragment(session: "a'b", message: nil) == nil)
        #expect(WatchAddress.fragment(session: String(repeating: "a", count: 65), message: nil) == nil)
    }

    // MARK: the page is told it is a Watch column

    @Test func aWatchColumnsPageIsLoadedWithTheColumnFlagAfterTheLoadCounter() {
        let base = URL(string: "http://localhost:8768/setup/transcript-reader/out/live/index.html")!
        let frag = WatchAddress.fragment(session: a, message: "t12ad57c7c69734480c8aaddb")
        #expect(WatchAddress.pageURL(base: base, fragment: nil, pin: nil, column: true)?.absoluteString == base.absoluteString + "?watch=1")
        #expect(WatchAddress.pageURL(base: base, fragment: frag, pin: 3, column: true)?.absoluteString == base.absoluteString + "?conn=3&watch=1#s=\(a)&m=t12ad57c7c69734480c8aaddb")
        // The flag is a query item and never part of the fragment: the page's address parser takes only `#s=...&m=...` and would refuse anything more.
        #expect(WatchAddress.pageURL(base: base, fragment: frag, pin: 3, column: true)?.fragment == "s=\(a)&m=t12ad57c7c69734480c8aaddb")
    }

    @Test func thePlainReaderPageNeverGetsTheColumnFlag() {
        let base = URL(string: "http://localhost:8768/setup/transcript-reader/out/index.html")!
        #expect(WatchAddress.pageURL(base: base, fragment: nil, pin: nil, column: false)?.absoluteString == base.absoluteString)
        #expect(WatchAddress.pageURL(base: base, fragment: "s=\(a)", pin: 7, column: false)?.absoluteString == base.absoluteString + "?conn=7#s=\(a)")
    }

    @Test func aBaseAddressKeepsItsOwnQueryAndConnsTwoItemsAreAlwaysSetAnew() {
        let base = URL(string: "http://localhost:8768/live/index.html?lab=1&conn=1&watch=1")!
        #expect(WatchAddress.pageURL(base: base, fragment: "s=\(a)", pin: 4, column: true)?.absoluteString == "http://localhost:8768/live/index.html?lab=1&conn=4&watch=1#s=\(a)")
        #expect(WatchAddress.pageURL(base: base, fragment: nil, pin: nil, column: false)?.absoluteString == "http://localhost:8768/live/index.html?lab=1")
    }

    @Test func aFilePageIsLoadedAsItIsBecauseAFileAddressCannotCarryAQuery() {
        // The stand-in page of a check is a file: WKWebView answers "The URL can't be shown" to a file address with a query (the first run of the
        // Watch check with the flag on said so), and the page takes its hash after it has loaded.
        let base = URL(fileURLWithPath: "/tmp/fixture/fixture-lite.html")
        for column in [true, false] {
            let url = WatchAddress.pageURL(base: base, fragment: "s=\(a)", pin: 2, column: column)
            #expect(url == base)
            #expect(url?.query == nil)
        }
    }
}
