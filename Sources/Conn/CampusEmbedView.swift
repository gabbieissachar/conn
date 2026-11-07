// Campus conversations drawn by the pmos reader's own page (ROADMAP E9=a). The Reader column and the Watch columns load the reader's embed page in a web view and
// feed it the conversation as JSON (`CampusEmbed.json`), so markdown, tables, code boxes and the "N steps" rows look exactly like a Claude or Codex session.
// The page asks nothing of the reader's server and keeps nothing; Campus data reaches it only through `window.readerEmbed.set`. Where the page cannot be had (the
// reader is not running, an older reader without the page, a page that does not answer) the native transcript stays, so a column is never empty.
import SwiftUI
import WebKit
import ConnCore

@MainActor
final class CampusEmbedBox: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    enum Phase: Equatable { case idle, loading, ready, unavailable(String) }

    /// Every box in the app, weakly (a check finds the page a column shows through this).
    static let live = NSHashTable<CampusEmbedBox>.weakObjects()
    /// A link in the page that is not a Campus conversation opens here. A check replaces it with a recorder so it never opens a browser.
    static var openExternal: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// How long a load may take before the native transcript is kept (seconds).
    static var loadTimeout = 8.0

    let webView: WKWebView
    @Published private(set) var phase = Phase.idle
    /// The conversation the page was last handed (test hook).
    private(set) var shownID: String?
    /// What the page answered to the last `set`: `{ok, blocks, skipped}` (test hook).
    private(set) var lastAnswer: [String: Any] = [:]
    private(set) var sets = 0
    /// The Watch column this page is drawn in, nil in the Reader column (test hook).
    var column: Int?
    /// A link the person clicked in the page, and whether Cmd was held.
    var onLink: ((URL, Bool) -> Void)?
    private var url: URL?
    private var pending: String?
    private var sent: String?
    private var handlerAdded = false
    private var timeout: Task<Void, Never>?
    private var proxy: MessageProxy?

    override init() {
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        Self.live.add(self)
    }

    // MARK: loading

    /// Load the page (once; a call on a loaded or unavailable box does nothing). nil: no page is configured, so the native transcript stays.
    func start(url: URL?) {
        guard phase == .idle else { return }
        guard let url = url else { phase = .unavailable("no embed page configured"); return }
        self.url = url
        if !handlerAdded {
            let p = MessageProxy(); p.box = self; proxy = p
            webView.configuration.userContentController.add(p, name: CampusEmbed.handlerName)
            handlerAdded = true
        }
        phase = .loading
        if url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) } else { webView.load(URLRequest(url: url)) }
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.loadTimeout * 1_000_000_000))
            guard !Task.isCancelled, let self = self, self.phase == .loading else { return }
            self.unavailable("the page did not answer in \(Int(Self.loadTimeout)) s")
        }
    }

    /// A box that gave up tries again when the person moves to another conversation (the reader may have started since).
    func retryIfUnavailable(url: URL?) {
        guard case .unavailable = phase else { return }
        phase = .idle
        sent = nil
        start(url: url)
    }

    /// Let go of the page: stop loading and drop the handler (the user content controller holds it strongly).
    func release() {
        timeout?.cancel(); timeout = nil
        webView.stopLoading()
        if handlerAdded { webView.configuration.userContentController.removeScriptMessageHandler(forName: CampusEmbed.handlerName); handlerAdded = false }
        proxy = nil
        if phase == .loading || phase == .ready { phase = .idle }
        sent = nil; pending = nil
    }

    private func becameReady() {
        guard phase == .loading else { return }
        timeout?.cancel(); timeout = nil
        phase = .ready
        if let p = pending { pending = nil; send(p) }
    }

    private func unavailable(_ why: String) {
        timeout?.cancel(); timeout = nil
        webView.stopLoading()
        phase = .unavailable(why)
    }

    // MARK: feeding the page

    /// Hand the page the conversation. `json` nil takes it away (privacy mode: nothing stays drawn behind the redacted native view). Equal text is not sent twice.
    func show(id: String, json: String?) {
        guard let json = json else {
            if sent != nil, phase == .ready { Task { _ = try? await webView.callAsyncJavaScript("window.readerEmbed.clear()", arguments: [:], in: nil, contentWorld: .page) } }
            sent = nil; pending = nil
            return
        }
        shownID = id
        guard json != sent, json != pending else { return }
        if phase == .ready { send(json) } else { pending = json }
    }

    private func send(_ json: String) {
        sent = json
        Task {
            do {
                let v = try await webView.callAsyncJavaScript("return window.readerEmbed.set(json)", arguments: ["json": json], in: nil, contentWorld: .page)
                sets += 1
                if let d = v as? [String: Any] { lastAnswer = d }
            } catch {
                sent = nil
                unavailable("the page refused the conversation: \(error.localizedDescription)")
            }
        }
    }

    /// Run a script in the page and give its result as text (a check's way of reading what the page drew).
    func read(_ script: String) async -> String {
        let r = try? await webView.evaluateJavaScript(script)
        return (r as? String) ?? (r.map { "\($0)" } ?? "")
    }

    // MARK: the page's messages

    fileprivate func message(_ body: [String: Any]) {
        switch body["type"] as? String {
        case "ready": if (body["version"] as? Int) == CampusEmbed.version { becameReady() }
        case "link":
            guard let s = body["url"] as? String, let u = URL(string: s), u.scheme == "https" || u.scheme == "http" else { return }
            let command = NSEvent.modifierFlags.contains(.command)
            if let h = onLink { h(u, command) } else { Self.openExternal(u) }
        default: break
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The page itself loads; anything else the page tries (a link it did not hand to Conn, a new window) never replaces it.
        if action.targetFrame?.isMainFrame != false, action.navigationType == .other || action.navigationType == .reload, let u = action.request.url, let mine = url,
           WebLinkPolicy.samePageIgnoringFragment(u, mine) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, let u = action.request.url, u.scheme == "https" || u.scheme == "http" { message(["type": "link", "url": u.absoluteString]) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = response.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            decisionHandler(.cancel)
            unavailable("the reader answered \(http.statusCode)")
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The page posts `ready` as it installs its entry point; ask too, in case the message went before the handler was listening.
        webView.evaluateJavaScript("typeof window.readerEmbed === 'object' && window.readerEmbed !== null && window.readerEmbed.version") { [weak self] v, _ in
            MainActor.assumeIsolated {
                guard let self = self, self.phase == .loading else { return }
                if (v as? Int) == CampusEmbed.version { self.becameReady() } else { self.unavailable("the page has no readerEmbed entry point (an older reader)") }
            }
        }
    }

    private func failed(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if phase == .loading { unavailable(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

    /// A new window (`target=_blank`, `window.open`) is refused; a web link it asked for goes where a link goes.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url, u.scheme == "https" || u.scheme == "http" { message(["type": "link", "url": u.absoluteString]) }
        return nil
    }
}

/// Receives the page's messages without keeping the box alive.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var box: CampusEmbedBox?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.box?.message(body) } }
    }
}

/// The page's web view in the window. It is always in the tree while the transcript is (a web view loads best attached) and shows once it is ready.
struct CampusEmbedPane: NSViewRepresentable {
    let box: CampusEmbedBox
    let id: String
    let json: String?
    var column: Int?
    let onLink: (URL, Bool) -> Void

    func makeNSView(context: Context) -> WebHostView {
        let v = WebHostView()
        v.attach(box.webView)
        return v
    }
    func updateNSView(_ v: WebHostView, context: Context) {
        v.attach(box.webView)
        box.onLink = onLink
        box.column = column
        box.show(id: id, json: json)
    }
}
