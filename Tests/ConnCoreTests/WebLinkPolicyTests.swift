import Testing
import Foundation
import ConnCore

@Suite("Web link policy") struct WebLinkPolicyTests {
    let reader = URL(string: "http://localhost:8768/setup/transcript-reader/out/prototype.html")!
    let organizer = URL(string: "http://localhost:8767/apps/wip-herdr-workspace-organizer.html")!
    var panes: [String: URL] { ["Reader": reader, "Organizer": organizer] }
    func route(_ s: String, from own: URL) -> WebLinkRoute { WebLinkPolicy.route(for: URL(string: s)!, ownBase: own, panes: panes) }

    @Test func aLinkFromTheOrganizerToTheReaderSwitchesPanesAndKeepsTheHash() {
        let url = "http://localhost:8768/setup/transcript-reader/out/prototype.html?x=1#s=abc123-def"
        #expect(route(url, from: organizer) == .showInPane(pane: "Reader", url: URL(string: url)!))
        // Another name for this machine is the same server.
        let loop = "http://127.0.0.1:8768/setup/transcript-reader/out/prototype.html#s=abc"
        #expect(route(loop, from: organizer) == .showInPane(pane: "Reader", url: URL(string: loop)!))
        #expect(route("http://[::1]:8768/x", from: organizer) == .showInPane(pane: "Reader", url: URL(string: "http://[::1]:8768/x")!))
    }

    @Test func linksInsideThePageAndNonWebAddressesStay() {
        #expect(route("http://localhost:8767/apps/other.html#a", from: organizer) == .allow)
        #expect(route("http://127.0.0.1:8767/api/herdr-organizer/token", from: organizer) == .allow)
        #expect(route("about:blank", from: organizer) == .allow)
        #expect(route("mailto:a@b.c", from: organizer) == .allow)
        #expect(route("http://localhost:8768/setup/transcript-reader/out/prototype.html#s=1", from: reader) == .allow)
    }

    @Test func everythingElseOpensInTheBrowser() {
        #expect(route("https://example.com/page", from: organizer) == .openInBrowser(URL(string: "https://example.com/page")!))
        #expect(route("http://localhost:9999/", from: organizer) == .openInBrowser(URL(string: "http://localhost:9999/")!))      // another port: not Conn's reader
        #expect(route("https://localhost:8768/", from: organizer) == .openInBrowser(URL(string: "https://localhost:8768/")!))    // another scheme
        #expect(route("http://reader.example.com:8768/", from: organizer) == .openInBrowser(URL(string: "http://reader.example.com:8768/")!))
    }

    @Test func aLinkFromTheReaderToTheOrganizerSwitchesPanesToo() {
        let url = "http://localhost:8767/apps/wip-herdr-workspace-organizer.html"
        #expect(route(url, from: reader) == .showInPane(pane: "Organizer", url: URL(string: url)!))
    }

    @Test func isPageIgnoresQueryAndFragmentButNotTheServerOrPath() {
        let base = reader
        #expect(WebLinkPolicy.isPage(base, URL(string: "http://localhost:8768/setup/transcript-reader/out/prototype.html?conn=3#s=abc")!))
        #expect(WebLinkPolicy.isPage(base, base))
        #expect(WebLinkPolicy.isPage(base, URL(string: "http://127.0.0.1:8768/setup/transcript-reader/out/prototype.html#s=abc")!))
        #expect(!WebLinkPolicy.isPage(base, URL(string: "http://localhost:8768/setup/transcript-reader/out/other.html")!))
        #expect(!WebLinkPolicy.isPage(base, URL(string: "http://localhost:8767/setup/transcript-reader/out/prototype.html")!))
        #expect(!WebLinkPolicy.isPage(base, URL(string: "https://localhost:8768/setup/transcript-reader/out/prototype.html")!))
        #expect(!WebLinkPolicy.isPage(base, nil))
        let file = URL(fileURLWithPath: "/tmp/fixture/fixture-reader.html")
        #expect(WebLinkPolicy.isPage(file, URL(string: "file:///tmp/fixture/fixture-reader.html#s=000000000001")!))
        #expect(!WebLinkPolicy.isPage(file, URL(fileURLWithPath: "/tmp/fixture/fixture-organizer.html")))
        #expect(!WebLinkPolicy.isPage(file, base))
    }

    @Test func samePageIgnoresOnlyTheFragment() {
        let a = URL(string: "http://localhost:8768/p.html?conn=3#s=a")!
        #expect(WebLinkPolicy.samePageIgnoringFragment(URL(string: "http://localhost:8768/p.html?conn=3#s=b")!, a))
        #expect(!WebLinkPolicy.samePageIgnoringFragment(URL(string: "http://localhost:8768/p.html?conn=4#s=a")!, a))
        #expect(!WebLinkPolicy.samePageIgnoringFragment(a, nil))
    }
}
