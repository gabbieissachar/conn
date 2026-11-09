// Campus conversations drawn by the pmos reader's own page (ROADMAP E9=a). The Reader column and the Watch columns load the reader's embed page in a web view and
// feed it the conversation as JSON (`CampusEmbed.json`), so markdown, tables, code boxes and the "N steps" rows look exactly like a Claude or Codex session.
// The page asks nothing of the reader's server and keeps nothing; Campus data reaches it only through `window.readerEmbed.set`. Conn reads the page itself and
// loads it as text on an opaque origin with all network loads blocked, so script in a rendered reply could not reach the reader's server or its token even if the page's own policy failed. Where the page cannot be had (the
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
    /// A `send` from the page is typed into Campus only when Conn itself saw a key or a click in this web view within `gestureWindow` seconds (the page holds a message for its own
    /// 5-second Undo window first, so the send lands a few seconds after the person's last action). Script in a rendered reply cannot make one. A check turns this off to post
    /// by script, and one step leaves it on to see the refusal.
    static var requireGesture = true
    static let gestureWindow: TimeInterval = 20

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
    /// A message the page's own composer hands over once it has held it through its Undo window (README "The embed page", "The composer"). Whoever listens answers with `answerSend`.
    var onSend: ((ReaderSend) -> Void)?
    /// The page took the composer (`readerEmbed.composer` exists and was called): the page has its own message bar, so Conn's own text box steps aside. False with an older page.
    @Published private(set) var composerOn = false
    /// What the page was last asked to show as its bar (name, Send on or off, the reason), to ask again only when it changes.
    private var composerWanted: String?
    private var composerAsked: String?
    private var url: URL?
    private var pending: String?
    private var sent: String?
    private var handlerAdded = false
    private var timeout: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    private var proxy: MessageProxy?
    /// When a key or a click last reached this web view (from the person, as AppKit saw it).
    private(set) var lastGesture: Date?
    private var gestureMonitor: Any?

    override init() {
        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        Self.live.add(self)
        gestureMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            MainActor.assumeIsolated { self?.noteGesture(event) }
            return event
        }
    }

    deinit { if let m = gestureMonitor { NSEvent.removeMonitor(m) } }

    /// Remember a key or a click that was for this web view (its window, and a click inside it or a key while something in it has the keyboard).
    private func noteGesture(_ event: NSEvent) {
        guard let window = webView.window, event.window === window else { return }
        if event.type == .keyDown {
            if let r = window.firstResponder as? NSView, r.isDescendant(of: webView) { lastGesture = Date() }
        } else if webView.bounds.contains(webView.convert(event.locationInWindow, from: nil)) {
            lastGesture = Date()
        }
    }

    /// Whether a send from the page may go now: a person's key or click reached this web view within `gestureWindow`.
    var gestureRecent: Bool {
        guard Self.requireGesture else { return true }
        guard let g = lastGesture else { return false }
        return Date().timeIntervalSince(g) <= Self.gestureWindow
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
        // The page is read by Conn and handed to the web view as text with no base address, so it runs on an opaque origin of its own: never the reader's (script in a
        // rendered reply could otherwise reach the reader's server and its routes) and with no file access. It must carry its own strict content policy, and no network
        // load of any kind is allowed in the view (a content rule list), whatever the page says.
        loading = Task { [weak self] in
            do {
                let html = try await Self.fetchPage(url)
                let rules = try await Self.noNetworkRules()
                guard let self = self, !Task.isCancelled, self.phase == .loading else { return }
                self.webView.configuration.userContentController.removeAllContentRuleLists()
                self.webView.configuration.userContentController.add(rules)
                self.webView.loadHTMLString(html, baseURL: nil)
            } catch {
                guard let self = self, !Task.isCancelled, self.phase == .loading else { return }
                self.unavailable((error as? PageError)?.reason ?? error.localizedDescription)
            }
        }
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
        loading?.cancel(); loading = nil
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
        composerAsked = nil
        if let p = pending { pending = nil; send(p) }
        applyComposer()
    }

    private func unavailable(_ why: String) {
        timeout?.cancel(); timeout = nil
        loading?.cancel(); loading = nil
        webView.stopLoading()
        phase = .unavailable(why)
    }


    // MARK: reading the page

    struct PageError: Error { let reason: String }

    /// The page as text, from a file or from the reader's server (200 only, 8 MB at most). It is refused unless it has the content policy the reader gives it
    /// (`default-src 'none'` and `connect-src 'none'`, as a `<meta>` tag, so it still holds when Conn hands the text over) and the entry point.
    static func fetchPage(_ url: URL) async throws -> String {
        let data: Data
        if url.isFileURL {
            guard let d = try? Data(contentsOf: url) else { throw PageError(reason: "the page file cannot be read") }
            data = d
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = 6
            cfg.httpCookieStorage = nil
            cfg.urlCredentialStorage = nil
            let (d, response) = try await URLSession(configuration: cfg).data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 { throw PageError(reason: "the reader answered \(http.statusCode)") }
            data = d
        }
        guard data.count <= 8_000_000, let html = String(data: data, encoding: .utf8) else { throw PageError(reason: "the page is not text or is too big") }
        guard html.contains("window.readerEmbed") || html.contains("readerEmbed") else { throw PageError(reason: "the page has no readerEmbed entry point (an older reader)") }
        guard policyOK(html) else { throw PageError(reason: "the page does not carry the strict content policy") }
        return html
    }

    /// Whether the page declares a content policy that shuts the network and everything else (`default-src 'none'`, `connect-src 'none'`) in a meta tag.
    static func policyOK(_ html: String) -> Bool {
        guard let r = html.range(of: "<meta http-equiv=\"Content-Security-Policy\"") else { return false }
        let tag = html[r.lowerBound...].prefix(while: { $0 != ">" })
        return tag.contains("default-src 'none'") && tag.contains("connect-src 'none'")
    }

    /// Blocks every load but the document itself: no image, style sheet, script file, font, fetch, socket, media or pop-up, from anywhere.
    static func noNetworkRules() async throws -> WKContentRuleList {
        let json = #"[{"trigger":{"url-filter":".*","resource-type":["image","style-sheet","script","font","raw","svg-document","media","popup","ping","fetch","websocket"]},"action":{"type":"block"}}]"#
        guard let list = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "conn.embed.no-network", encodedContentRuleList: json) else {
            throw PageError(reason: "the no-network rules did not compile")
        }
        return list
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

    // MARK: the page's own message bar

    /// Ask for the page's message bar (select-to-ask, comments, the batch, Send, Undo, Now) for this conversation, or take it away (nil). Asked again only when it changes or the page
    /// has reloaded. An older page without `readerEmbed.composer` ignores it, and Conn's own box stays (`composerOn` false).
    func setComposer(_ config: String?) {
        composerWanted = config
        applyComposer()
    }

    /// Ask the page again for the bar it was last wanted to show (a check installs a stand-in page function after load and calls this).
    func refreshComposer() { composerAsked = nil; applyComposer() }

    private func applyComposer() {
        guard phase == .ready, composerAsked != composerWanted else { return }
        composerAsked = composerWanted
        let arg = composerWanted ?? "null"
        Task {
            let v = try? await webView.callAsyncJavaScript("if (typeof window.readerEmbed.composer !== 'function') { return false; } window.readerEmbed.composer(cfg === 'null' ? null : cfg); return cfg !== 'null';", arguments: ["cfg": arg], in: nil, contentWorld: .page)
            composerOn = (v as? Bool) == true
        }
    }

    /// Tell the page how a `send` ended: nil error means Campus took it (the page keeps its faded message until the conversation shows it), else why not (the page gives it back).
    func answerSend(id: String, error: String?) {
        guard phase == .ready else { return }
        let result = CampusEmbed.sentResult(id: id, error: error)
        Task { _ = try? await webView.callAsyncJavaScript("if (typeof window.readerEmbed.sent === 'function') { window.readerEmbed.sent(JSON.parse(r)); } return true;", arguments: ["r": result], in: nil, contentWorld: .page) }
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
        case "send":
            // Only a page with the bar on may send, and only a well-formed message; anything else is answered at once so the page can give the text back.
            guard let id = body["id"] as? String else { return }
            guard composerOn, let msg = CampusEmbed.parseSend(body) else { answerSend(id: id, error: "Conn did not accept that message"); return }
            guard gestureRecent else { answerSend(id: id, error: "Conn saw no key or click in this column just now, so it did not send."); return }
            if let h = onSend { h(msg) } else { answerSend(id: id, error: "Nothing is listening for it") }
        default: break
        }
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The page itself loads (handed over as text, so its address is about:blank); anything else the page tries (a link it did not hand to Conn, a new window) never replaces it.
        if action.targetFrame?.isMainFrame != false, action.navigationType == .other, action.request.url?.absoluteString == "about:blank" { decisionHandler(.allow); return }
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
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
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
    /// The page's message bar: its `composer(config)` argument, or nil for none (privacy mode, no conversation).
    var composer: String?
    var onSend: ((ReaderSend) -> Void)?

    func makeNSView(context: Context) -> WebHostView {
        let v = WebHostView()
        v.attach(box.webView)
        return v
    }
    func updateNSView(_ v: WebHostView, context: Context) {
        v.attach(box.webView)
        box.onLink = onLink
        box.onSend = onSend
        box.column = column
        box.setComposer(composer)
        box.show(id: id, json: json)
    }
}
