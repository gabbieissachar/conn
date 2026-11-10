import Testing
import Foundation
import CoreGraphics
@testable import ConnCore

@Suite("Original reply panel") struct ReplyPanelTests {
    // MARK: what a hand-off may hold

    @Test func aHandOffWithAReplyIsTaken() {
        let c = ReplyPanelContent.parse(["title": "Original reply", "meta": "asked 10:32", "source": "leader-esim", "html": "<p>Hello</p>", "css": ".md{color:red}"])
        #expect(c == ReplyPanelContent(title: "Original reply", meta: "asked 10:32", source: "leader-esim", html: "<p>Hello</p>", css: ".md{color:red}"))
    }

    @Test func aHandOffWithNoReplyOrNoDictionaryIsRefused() {
        #expect(ReplyPanelContent.parse(["html": ""]) == nil)
        #expect(ReplyPanelContent.parse(["html": "   \n  "]) == nil)
        #expect(ReplyPanelContent.parse(["title": "x"]) == nil)
        #expect(ReplyPanelContent.parse("<p>x</p>") == nil)
        #expect(ReplyPanelContent.parse(["html": 5]) == nil)
    }

    @Test func aMissingTitleIsTheDefaultAndLongTextIsShortened() {
        let c = ReplyPanelContent.make(title: nil, meta: String(repeating: "m", count: 500), source: String(repeating: "s", count: 500), html: "<p>x</p>", css: nil)
        #expect(c?.title == "Original reply")
        #expect(c?.meta.count == ReplyPanelContent.maxMeta)
        #expect(c?.meta.hasSuffix("\u{2026}") == true)
        #expect(c?.source.count == ReplyPanelContent.maxSource)
        #expect(c?.css == "")
    }

    @Test func aReplyThatIsTooBigIsRefusedWholeNotCutAndTooBigStylesAreLeftOut() {
        let big = "<p>" + String(repeating: "a", count: ReplyPanelContent.maxHTML) + "</p>"
        #expect(ReplyPanelContent.make(title: nil, meta: nil, source: nil, html: big, css: nil) == nil)
        let c = ReplyPanelContent.make(title: nil, meta: nil, source: nil, html: "<p>ok</p>", css: String(repeating: "a", count: ReplyPanelContent.maxCSS + 1))
        #expect(c?.html == "<p>ok</p>")
        #expect(c?.css == "")
    }

    // MARK: where the panel may sit

    private let window = CGSize(width: 1200, height: 800)

    @Test func itOpensInsideTheWindowOnTheRightBelowTheToolbar() {
        let f = ReplyPanelFrame.initial(in: window)
        #expect(f.x + f.width <= window.width)
        #expect(f.y >= 0 && f.y + f.height <= window.height)
        #expect(f.width >= ReplyPanelFrame.minWidth && f.height >= ReplyPanelFrame.minHeight)
        #expect(f.x > window.width / 2 - 1)
        // A small window still holds a panel of the minimum size.
        let tiny = ReplyPanelFrame.initial(in: CGSize(width: 300, height: 200))
        #expect(tiny.width >= ReplyPanelFrame.minWidth && tiny.height >= ReplyPanelFrame.minHeight)
    }

    @Test func itCanBeDraggedAcrossTheWholeWindowButNeverWhereItsHeaderCannotBeGrabbed() {
        var f = ReplyPanelFrame(x: 600, y: 100, width: 400, height: 300)
        f = f.moved(by: CGSize(width: -590, height: 20), in: window)              // to the far left: it may leave the window at the left, as far as its keep-visible strip
        #expect(f.x == -590 + 600 && f.y == 120)
        f = f.moved(by: CGSize(width: -2000, height: 0), in: window)
        #expect(f.x + f.width >= ReplyPanelFrame.keepVisible)                      // the right strip of the panel stays inside
        f = f.moved(by: CGSize(width: 5000, height: 5000), in: window)
        #expect(f.x <= window.width - ReplyPanelFrame.keepVisible)                 // the left strip stays inside
        #expect(f.y <= window.height - ReplyPanelFrame.headerHeight)               // the header stays inside at the bottom
        f = f.moved(by: CGSize(width: 0, height: -9000), in: window)
        #expect(f.y == 0)                                                          // and at the top
    }

    @Test func dragMovesThePanelWithoutChangingItsSize() {
        let f = ReplyPanelFrame(x: 100, y: 100, width: 420, height: 310)
        let g = f.moved(by: CGSize(width: 250, height: -40), in: window)
        #expect(g == ReplyPanelFrame(x: 350, y: 60, width: 420, height: 310))
    }

    @Test func resizingFromTheCornerKeepsTheMinimumAndStopsAtTheWindowEdge() {
        let f = ReplyPanelFrame(x: 700, y: 100, width: 400, height: 300)
        let bigger = f.resized(by: CGSize(width: 900, height: 900), in: window)
        #expect(bigger.x == 700 && bigger.y == 100)
        #expect(bigger.x + bigger.width <= window.width && bigger.y + bigger.height <= window.height)
        let smaller = f.resized(by: CGSize(width: -900, height: -900), in: window)
        #expect(smaller.width == ReplyPanelFrame.minWidth && smaller.height == ReplyPanelFrame.minHeight)
    }

    @Test func aSmallerWindowPullsAPanelBackInside() {
        let f = ReplyPanelFrame(x: 1000, y: 700, width: 600, height: 500)
        let g = f.clamped(in: CGSize(width: 800, height: 600))
        #expect(g.width <= 800 && g.height <= 600)
        #expect(g.x <= 800 - ReplyPanelFrame.keepVisible)
        #expect(g.y <= 600 - ReplyPanelFrame.headerHeight)
    }

    @Test func aFrameSurvivesBeingSavedAndRead() throws {
        let f = ReplyPanelFrame(x: 12.5, y: 80, width: 444, height: 333)
        let back = try JSONDecoder().decode(ReplyPanelFrame.self, from: JSONEncoder().encode(f))
        #expect(back == f)
    }

    // MARK: the page the panel shows

    @Test func theDocumentCarriesTheStylesTheReplyAndAPolicyThatAllowsNoScript() {
        let c = ReplyPanelContent(title: "Original reply", meta: "", source: "", html: "<table class=\"t\"><tr><td>a</td></tr></table><script>window.x=1</script>", css: ".t{border:1px solid}")
        let d = ReplyPanelDocument.html(c)
        #expect(d.contains("<style>.t{border:1px solid}</style>"))
        #expect(d.contains("<div class=\"rp-body\" id=\"reply-body\"><table class=\"t\">"))
        #expect(d.contains("default-src 'none'"))
        #expect(d.contains("style-src 'unsafe-inline'"))
        #expect(!d.contains("script-src"))                                         // nothing the reply holds may run
        #expect(d.range(of: "<style>.t{border:1px solid}</style>")!.lowerBound < d.range(of: "<div class=\"rp-body\"")!.lowerBound)
    }
}
