// `--ui-check` step for the reader pin (an agent selection and a starred chip both call `WebBox.pin`).
// A pin must switch the reader in place, with no page load, when the page on screen follows an address change, and must
// load the page as before when it does not. Proof is a marker written on the page's `window`: a page load throws it away,
// an in-place switch leaves it. Two scratch pages are served from a throwaway local server, so the live path (an http page,
// the `?conn=<n>` load) is checked without the owner's reader: a page that follows `hashchange`, and an older one that reads
// its address only at load. With the real reader (no --fixture) the pin is also tried on the owner's page, read-only.
import SwiftUI
import Network
import WebKit
import ConnCore

/// A server for two invented pages on a free local port. It answers every GET with the page for that path and closes.
final class PinPageServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "conn.pin-page-server")
    private(set) var port: UInt16 = 0
    private let pages: [String: String]

    init?(pages: [String: String]) {
        self.pages = pages
        guard let l = try? NWListener(using: .tcp, on: .any) else { return nil }
        listener = l
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let p = self?.listener.port?.rawValue { self?.port = p; ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.serve(conn) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, port != 0 else { listener.cancel(); return nil }
    }

    private func serve(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self = self else { conn.cancel(); return }
            let head = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let target = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let path = String(target.split(separator: "?").first ?? "/")
            let body = self.pages[path]
            let text = body ?? "not found"
            let bytes = Data(text.utf8)
            let header = "HTTP/1.1 \(body == nil ? "404 Not Found" : "200 OK")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
            conn.send(content: Data(header.utf8) + bytes, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    func stop() { listener.cancel() }
}

@MainActor
enum ReaderPinCheck {
    /// Shows the session the address names: `#now` is its text. The modern page redraws on `hashchange`, as the reader does.
    static let modernPage = """
    <!doctype html><meta charset="utf-8"><title>modern</title>
    <p id="now"></p>
    <script>
      function show() { document.getElementById('now').textContent = location.hash; }
      window.addEventListener('hashchange', show); show();
    </script>
    """
    /// Reads its address once, at load, like a reader that predates the in-place change.
    static let legacyPage = """
    <!doctype html><meta charset="utf-8"><title>legacy</title>
    <p id="now"></p>
    <script>document.getElementById('now').textContent = location.hash;</script>
    """

    static func js(_ box: WebBox, _ script: String) async -> String {
        await withCheckedContinuation { c in
            box.webView.evaluateJavaScript(script) { r, _ in c.resume(returning: r.map { "\($0)" } ?? "") }
        }
    }

    static func settled(_ box: WebBox, wait: (Double) async -> Void) async {
        var n = 0; while box.phase != .ready && n < 60 { await wait(0.1); n += 1 }
    }

    /// Polls `read()` until it equals `want` or about 4 s pass; the time it took in milliseconds.
    static func until(_ want: String, wait: (Double) async -> Void, read: () async -> String) async -> (value: String, ms: Int) {
        let t0 = Date()
        var v = await read()
        var n = 0
        while v != want && n < 40 { await wait(0.1); v = await read(); n += 1 }
        return (v, Int(Date().timeIntervalSince(t0) * 1000))
    }

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard let server = PinPageServer(pages: ["/modern.html": modernPage, "/legacy.html": legacyPage]) else {
            report("a scratch local server for the pin pages starts", false, "could not listen"); return
        }
        defer { server.stop() }
        let root = "http://127.0.0.1:\(server.port)"

        // 1. A page that follows an address change: a pin changes the address and nothing loads.
        let modern = WebBox(kind: .reader, baseURL: URL(string: "\(root)/modern.html")!, fixtureDir: nil)
        modern.load(modern.baseURL); await settled(modern, wait: wait)
        let token = "marker-\(Int.random(in: 100000...999999))"
        _ = await js(modern, "window.__pinMarker='\(token)'")
        let loaded = modern.loadSeconds
        modern.pin(sessionID: "11111111-aaaa")
        let first = await until("#s=11111111-aaaa", wait: wait) { await js(modern, "document.getElementById('now').textContent") }
        var marker = await js(modern, "window.__pinMarker || 'gone'")
        report("a pin on a reader that follows its address switches in place: the page shows the session and the window marker survives",
               first.value == "#s=11111111-aaaa" && marker == token && modern.pinsInPlace == 1 && modern.pinsLoaded == 0 && modern.loadSeconds == loaded,
               "shows=\(first.value) marker=\(marker == token ? "kept" : marker) inPlace=\(modern.pinsInPlace) loads=\(modern.pinsLoaded) after \(first.ms) ms")
        modern.pin(sessionID: "22222222-bbbb")
        modern.pin(sessionID: "33333333-cccc")
        let third = await until("#s=33333333-cccc", wait: wait) { await js(modern, "document.getElementById('now').textContent") }
        marker = await js(modern, "window.__pinMarker || 'gone'")
        report("two pins in a row both stay in place and the last one wins",
               third.value == "#s=33333333-cccc" && marker == token && modern.pinsInPlace == 3 && modern.pinsLoaded == 0 && modern.shownSession == "33333333-cccc",
               "shows=\(third.value) shownSession=\(modern.shownSession ?? "nil") marker=\(marker == token ? "kept" : marker) inPlace=\(modern.pinsInPlace) loads=\(modern.pinsLoaded)")
        modern.pin(sessionID: "33333333-cccc"); await wait(0.5)
        marker = await js(modern, "window.__pinMarker || 'gone'")
        report("a pin on the session already on screen leaves the page alone", marker == token && modern.pinsLoaded == 0 && modern.loadSeconds == loaded && modern.phase == .ready, "marker=\(marker == token ? "kept" : marker) loads=\(modern.pinsLoaded)")

        // 2. A page that reads its address only at load: the pin loads the page as before, and the page shows the session.
        let legacy = WebBox(kind: .reader, baseURL: URL(string: "\(root)/legacy.html")!, fixtureDir: nil)
        legacy.load(legacy.baseURL); await settled(legacy, wait: wait)
        _ = await js(legacy, "window.__pinMarker='\(token)'")
        legacy.pin(sessionID: "44444444-dddd")
        let fell = await until("#s=44444444-dddd", wait: wait) { await js(legacy, "document.getElementById('now').textContent") }
        await settled(legacy, wait: wait)
        marker = await js(legacy, "window.__pinMarker || 'gone'")
        report("a pin on an older reader (no address-change handler) loads the page as before and the page shows the session",
               fell.value == "#s=44444444-dddd" && marker == "gone" && legacy.pinsLoaded == 1 && legacy.pinsInPlace == 0,
               "shows=\(fell.value) marker=\(marker) inPlace=\(legacy.pinsInPlace) loads=\(legacy.pinsLoaded) url=\(legacy.webView.url?.absoluteString ?? "-")")
        legacy.pin(sessionID: "55555555-eeee")
        let again = await until("#s=55555555-eeee", wait: wait) { await js(legacy, "document.getElementById('now').textContent") }
        report("and a second pin on it loads again (a new query makes a new document)", again.value == "#s=55555555-eeee" && legacy.pinsLoaded == 2, "shows=\(again.value) loads=\(legacy.pinsLoaded)")

        // 3. Another page or server, or a page still loading, is a load, not an address change.
        let elsewhere = WebBox(kind: .reader, baseURL: URL(string: "\(root)/modern.html")!, fixtureDir: nil)
        elsewhere.pin(sessionID: "66666666-ffff")
        let first2 = await until("#s=66666666-ffff", wait: wait) { await js(elsewhere, "document.getElementById('now')?.textContent || ''") }
        report("a pin before the page has ever loaded is a load", first2.value == "#s=66666666-ffff" && elsewhere.pinsLoaded == 1 && elsewhere.pinsInPlace == 0, "shows=\(first2.value) loads=\(elsewhere.pinsLoaded)")
        elsewhere.load(URL(string: "\(root)/legacy.html")!); await settled(elsewhere, wait: wait)
        elsewhere.pin(sessionID: "77777777-0000")
        let other = await until("#s=77777777-0000", wait: wait) { await js(elsewhere, "document.getElementById('now')?.textContent || ''") }
        report("a pin while the web view shows another page loads the reader page", other.value == "#s=77777777-0000" && elsewhere.pinsLoaded == 2 && elsewhere.webView.url?.path == "/modern.html", "shows=\(other.value) loads=\(elsewhere.pinsLoaded) path=\(elsewhere.webView.url?.path ?? "-")")

        // 4. The pane's own reader: the fixture page follows its address (the same path), and with the real reader the owner's
        //    page is tried read-only (page loads and address changes only).
        let reader = model.web.box(.reader)
        model.showWeb = true; model.webTab = .reader
        await settled(reader, wait: wait)
        if model.config.fixture {
            _ = await js(reader, "window.__pinMarker='\(token)'")
            let before = reader.loadSeconds
            reader.pin(sessionID: "000000000004")
            let shown = await until("Waiting for you · ledger-reconcile", wait: wait) { await js(reader, "(document.getElementById('picker').selectedOptions[0]||{}).textContent||''") }
            let m = await js(reader, "window.__pinMarker || 'gone'")
            report("the fixture reader pane switches in place on a pin (marker kept, no new load time), and the chip follows",
                   m == token && reader.loadSeconds == before && reader.shownSession == "000000000004" && shown.value.hasSuffix("ledger-reconcile"),
                   "marker=\(m == token ? "kept" : m) shown=\(shown.value) shownSession=\(reader.shownSession ?? "nil") inPlace=\(reader.pinsInPlace) loads=\(reader.pinsLoaded)")
        } else {
            let ids = Array(Set(model.snapshot.agents.compactMap(\.sessionID).filter { $0.count >= 8 })).sorted()
            let now = reader.shownSession
            let other = ids.first { !StarSelection.matches(conv: $0, shown: now) }
            if let target = other {
                let follows = await js(reader, "String(window.\(WebBox.listenerFlag))")
                _ = await js(reader, "window.__pinMarker='\(token)'")
                let before = reader.loadSeconds, inPlace = reader.pinsInPlace, loads = reader.pinsLoaded
                let t0 = Date()
                reader.pin(sessionID: target)
                let want = String(target.prefix(8))
                let got = await until(want, wait: wait) { StarSelection.sessionPrefix(inFragment: reader.webView.url?.fragment).map { String($0.prefix(8)) } ?? "" }
                let m = await js(reader, "window.__pinMarker || 'gone'")
                print("ui-check: pin timing on the real reader: address shows the new session after \(got.ms) ms (since the pin call \(Int(Date().timeIntervalSince(t0) * 1000)) ms); reader follows address=\(follows)")
                if follows == "true" {
                    report("the real reader switches in place on a pin: marker kept, no page load", m == token && reader.loadSeconds == before && reader.pinsInPlace == inPlace + 1 && reader.pinsLoaded == loads,
                           "marker=\(m == token ? "kept" : m) address=\(got.value) inPlace=\(reader.pinsInPlace - inPlace) loads=\(reader.pinsLoaded - loads)")
                } else {
                    print("ui-check: NOTE the real reader does not listen for an address change (an older build): the pin loaded the page, as it did before")
                    report("an older real reader still gets the pin by a page load", reader.pinsLoaded == loads + 1, "loads=\(reader.pinsLoaded - loads)")
                }
                await settled(reader, wait: wait)
            } else {
                print("ui-check: SKIP pinning the real reader (no agent session other than the one on screen)")
            }
        }
    }
}
