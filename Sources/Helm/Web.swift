// Web panes: the captain's existing transcript reader (:8768) and Herdr organizer (:8765) shown in WKWebView.
// With --fixture the same two slots load invented local pages instead, so nothing private reaches a screenshot.
// Helm only loads these pages. It never serves them, restarts their servers or writes to them.
import SwiftUI
import WebKit

enum WebKind: String, CaseIterable, Identifiable {
    case reader = "Reader"
    case organizer = "Organizer"
    var id: String { rawValue }
    var symbol: String { self == .reader ? "text.bubble" : "square.grid.2x2" }
}

final class WebBox: NSObject, ObservableObject, WKNavigationDelegate {
    enum Phase: Equatable { case idle, loading, ready, failed(String) }

    let kind: WebKind
    let webView: WKWebView
    let baseURL: URL
    let fixtureDir: URL?
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var title = ""
    @Published private(set) var loadSeconds: Double?
    @Published private(set) var pinnedTo: String?
    private var loadStart: Date?
    private var pinCounter = 0
    private var pendingHash: String?

    init(kind: WebKind, baseURL: URL, fixtureDir: URL?) {
        self.kind = kind
        self.baseURL = baseURL
        self.fixtureDir = fixtureDir
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
    }

    var pid: Int32? { (webView.value(forKey: "_webProcessIdentifier") as? Int).map { Int32($0) } }

    func loadIfNeeded() { if phase == .idle { load(baseURL) } }

    func load(_ url: URL) {
        phase = .loading
        loadStart = Date()
        if let dir = fixtureDir, url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: dir) } else { webView.load(URLRequest(url: url)) }
    }

    func reload() { phase = .loading; loadStart = Date(); if webView.url == nil { load(baseURL) } else { webView.reload() } }

    /// Open the reader on one conversation. The real reader only reads `#s=<session id prefix>` when the page loads,
    /// so a live pin is a page load (a query string makes WKWebView treat it as a new document, not a fragment jump).
    func pin(sessionID: String?, label: String) {
        guard kind == .reader, let sid = sessionID, sid.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { pinnedTo = nil; return }
        pinnedTo = label
        if fixtureDir != nil {
            if webView.url?.path == baseURL.path { webView.evaluateJavaScript("location.hash='s=\(sid)'", completionHandler: nil) }
            else { pendingHash = "s=\(sid)"; load(baseURL) }
            return
        }
        pinCounter += 1
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "helm", value: "\(pinCounter)")]
        comps.fragment = "s=\(sid)"
        if let url = comps.url { load(url) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        phase = .ready
        title = webView.title ?? ""
        if let s = loadStart { loadSeconds = Date().timeIntervalSince(s) }
        if let h = pendingHash { pendingHash = nil; webView.evaluateJavaScript("location.hash='\(h)'", completionHandler: nil) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { phase = .failed(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { phase = .failed(error.localizedDescription) }

    /// Links that leave the page open in the default browser instead of replacing the reader.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url, url.host != baseURL.host || (url.port != baseURL.port) , url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// DOM probe used by the self test: ready state and element count.
    func probe(_ done: @escaping (String) -> Void) {
        webView.evaluateJavaScript("JSON.stringify({ready:document.readyState,nodes:document.getElementsByTagName('*').length})") { r, e in
            done((r as? String) ?? "error: \(e?.localizedDescription ?? "nil")")
        }
    }
}

final class WebHub {
    let fixture: Bool
    let resourceDir: URL?
    private(set) var readerBox: WebBox?
    private(set) var organizerBox: WebBox?

    init(fixture: Bool, resourceDir: URL?) { self.fixture = fixture; self.resourceDir = resourceDir }

    /// Web views are created the first time a layout shows them, so a layout without them never pays for WebKit.
    func box(_ kind: WebKind) -> WebBox {
        switch kind {
        case .reader:
            if let b = readerBox { return b }
            let b = make(.reader); readerBox = b; return b
        case .organizer:
            if let b = organizerBox { return b }
            let b = make(.organizer); organizerBox = b; return b
        }
    }

    private func make(_ kind: WebKind) -> WebBox {
        if fixture, let dir = resourceDir {
            let name = kind == .reader ? "fixture-reader.html" : "fixture-organizer.html"
            return WebBox(kind: kind, baseURL: dir.appendingPathComponent(name), fixtureDir: dir)
        }
        let env = ProcessInfo.processInfo.environment
        let readerURL = env["HELM_READER_URL"] ?? "http://localhost:8768/setup/transcript-reader/out/prototype.html"
        let organizerURL = env["HELM_ORGANIZER_URL"] ?? "http://localhost:8765/apps/wip-herdr-workspace-organizer.html"
        return WebBox(kind: kind, baseURL: URL(string: kind == .reader ? readerURL : organizerURL)!, fixtureDir: nil)
    }

    var allBoxes: [WebBox] { [readerBox, organizerBox].compactMap { $0 } }
}

/// SwiftUI owns this container; the long-lived WKWebView is moved into whichever container is on screen,
/// so layouts can switch without SwiftUI ever managing one NSView in two places at once.
final class WebHostView: NSView {
    func attach(_ web: WKWebView) {
        guard web.superview !== self else { return }
        web.removeFromSuperview()
        web.frame = bounds
        web.autoresizingMask = [.width, .height]
        addSubview(web)
    }
}

struct WebPaneRep: NSViewRepresentable {
    let box: WebBox
    func makeNSView(context: Context) -> WebHostView {
        let v = WebHostView()
        v.attach(box.webView)
        // Loading publishes box.phase, so it must not happen while SwiftUI is still computing the view update.
        DispatchQueue.main.async { box.loadIfNeeded() }
        return v
    }
    func updateNSView(_ v: WebHostView, context: Context) {
        v.attach(box.webView)
        // Switching the tab swaps the box under the same view, so makeNSView does not run again: load here too
        // (loadIfNeeded only acts on a box that has never loaded).
        DispatchQueue.main.async { box.loadIfNeeded() }
    }
}
