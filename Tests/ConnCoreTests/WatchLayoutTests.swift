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
}
