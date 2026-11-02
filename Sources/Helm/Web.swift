// Web panes: the captain's existing transcript reader (:8768) and Herdr organizer (:8765) shown in WKWebView.
// With --fixture the same two slots load invented local pages instead, so nothing private reaches a screenshot.
// Helm only loads these pages. It never serves them, restarts their servers or writes to them.
import SwiftUI
import WebKit
import HelmCore

enum WebKind: String, CaseIterable, Identifiable {
    case reader = "Reader"
    case organizer = "Organizer"
    var id: String { rawValue }
    var symbol: String { self == .reader ? "text.bubble" : "square.grid.2x2" }
}

final class WebBox: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
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
    /// The addresses of Helm's panes by name, so a link between them can be told from one that leaves Helm.
    var paneAddresses: () -> [String: URL] = { [:] }
    /// A link that points at another Helm pane: switch to it and show that address.
    var showInPane: ((WebKind, URL) -> Void)?
    /// A link that leaves Helm. A test replaces it with a recorder so a check never opens a browser.
    var openInBrowser: (URL) -> Void = { NSWorkspace.shared.open($0) }

    init(kind: WebKind, baseURL: URL, fixtureDir: URL?) {
        self.kind = kind
        self.baseURL = baseURL
        self.fixtureDir = fixtureDir
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
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
        if kind == .organizer { showContextView() }
    }

    // MARK: the organizer opens on its Context view

    /// The organizer page starts on its Restart view and has no memory of a chosen view, so Helm selects the Context view
    /// (the button `data-view="context"`) every time the Organizer pane opens or its page loads. The page builds its views
    /// from data it fetches, so the click is checked and repeated a few times until the Context view is the selected one.
    /// Nothing is edited in the page's source; this is one click on its own button.
    func showContextView(attempts: Int = 5) {
        guard kind == .organizer, phase == .ready else { return }
        let script = """
        (function () {
          var b = document.querySelector('[data-view="context"]');
          if (!b) return 'none';
          if (b.getAttribute('aria-selected') !== 'true') b.click();
          return b.getAttribute('aria-selected') === 'true' ? 'selected' : 'clicked';
        })()
        """
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self = self else { return }
            if (result as? String) == "selected" || attempts <= 1 { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.showContextView(attempts: attempts - 1) }
        }
    }

    /// Which view the organizer shows (test hook): the label of the selected view button, or nil if there is none.
    func selectedOrganizerView(_ done: @escaping (String?) -> Void) {
        webView.evaluateJavaScript("(function(){var b=document.querySelector('[data-view][aria-selected=\"true\"]');return b?b.getAttribute('data-view'):null;})()") { r, _ in done(r as? String) }
    }

    // MARK: links between Helm's panes

    /// Show this exact address in the pane (the reader keeps its `#s=` hash). If the pane already shows that page, only the
    /// hash changes, so nothing reloads.
    func show(address url: URL) {
        if fixtureDir == nil, WebLinkPolicy.samePageIgnoringFragment(url, webView.url), phase == .ready {
            let h = (url.fragment ?? "").replacingOccurrences(of: "'", with: "")
            webView.evaluateJavaScript("location.hash='\(h)'", completionHandler: nil)
            return
        }
        load(url)
    }

    private func handle(_ route: WebLinkRoute) {
        switch route {
        case .allow: break
        case .showInPane(let name, let url):
            if let k = WebKind(rawValue: name) { showInPane?(k, url) }
        case .openInBrowser(let url): openInBrowser(url)
        }
    }

    /// `target=_blank` and `window.open` ask for a new window; Helm has none, so the link is routed like any other and no
    /// web view is created (returning nil refuses the new window).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            let route = WebLinkPolicy.route(for: url, ownBase: baseURL, panes: paneAddresses())
            handle(route == .allow ? (url.scheme == "http" || url.scheme == "https" ? .showInPane(pane: kind.rawValue, url: url) : .allow) : route)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { phase = .failed(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { phase = .failed(error.localizedDescription) }

    /// A link to the other Helm pane switches to it (exact address, hash kept); any other link that leaves the page opens in
    /// the default browser instead of replacing the pane. Links inside the page, and everything that is not a click, load as usual.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.navigationType == .linkActivated, let url = action.request.url {
            let route = WebLinkPolicy.route(for: url, ownBase: baseURL, panes: paneAddresses())
            if route != .allow { handle(route); decisionHandler(.cancel); return }
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
    /// A link in one pane points at the other: the app switches tabs and has the box show the address.
    var onShowPane: ((WebKind, URL) -> Void)?

    init(fixture: Bool, resourceDir: URL?) { self.fixture = fixture; self.resourceDir = resourceDir }

    /// Where each pane's page lives (the same addresses `make` loads).
    func baseURL(_ kind: WebKind) -> URL {
        if fixture, let dir = resourceDir { return dir.appendingPathComponent(kind == .reader ? "fixture-reader.html" : "fixture-organizer.html") }
        let env = ProcessInfo.processInfo.environment
        let reader = env["HELM_READER_URL"] ?? "http://localhost:8768/setup/transcript-reader/out/prototype.html"
        let organizer = env["HELM_ORGANIZER_URL"] ?? "http://localhost:8765/apps/wip-herdr-workspace-organizer.html"
        return URL(string: kind == .reader ? reader : organizer)!
    }

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
        let box = WebBox(kind: kind, baseURL: baseURL(kind), fixtureDir: fixture ? resourceDir : nil)
        box.paneAddresses = { [weak self] in
            guard let self = self else { return [:] }
            return Dictionary(uniqueKeysWithValues: WebKind.allCases.map { ($0.rawValue, self.baseURL($0)) })
        }
        box.showInPane = { [weak self] k, url in self?.onShowPane?(k, url) }
        return box
    }

    var allBoxes: [WebBox] { [readerBox, organizerBox].compactMap { $0 } }
}

/// SwiftUI owns this container; the long-lived WKWebView is moved into whichever container is on screen,
/// so layouts can switch without SwiftUI ever managing one NSView in two places at once.
/// The Reader and Organizer tabs share one container (the tab swaps the box under the same SwiftUI view), so it holds
/// exactly one web view at a time: attaching one takes the other out. Left in, the web view attached first would sit
/// behind the one attached second, and its tab would show the other page.
final class WebHostView: NSView {
    func attach(_ web: WKWebView) {
        for other in subviews where other !== web { other.removeFromSuperview() }
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
