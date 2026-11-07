// Web panes: the captain's existing transcript reader (:8768) and Herdr organizer (:8765) shown in WKWebView.
// With --fixture the same two slots load invented local pages instead, so nothing private reaches a screenshot.
// Conn only loads these pages. It never serves them, restarts their servers or writes to them.
import SwiftUI
import WebKit
import ConnCore

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
    /// The session the page's address names (`#s=<id or its first eight characters>`), which is how the Reader pane's row of
    /// starred sessions knows which chip is on screen. The reader rewrites its address when it picks a session itself, so
    /// this follows its own picker too.
    @Published private(set) var shownSession: String?
    private var urlObservation: NSKeyValueObservation?
    private var loadStart: Date?
    private var pinCounter = 0
    private var pendingHash: String?
    /// A Watch column: the reader's lite page, one conversation per page (see `WatchModel`). It shows its own address, never the
    /// reader's, and tells the model when the person uses it.
    let lite: Bool
    /// What a lite box opens on, as the address fragment (`s=<session>` or `s=<session>&m=<turn id>`), until it has loaded once.
    private(set) var startFragment: String?
    /// The person clicked, scrolled, typed or focused inside the page (lite boxes only).
    var onUse: (() -> Void)?
    /// The person clicked a session link in the page (`a[data-session]`, which the reader draws where a reply names another session):
    /// the session it names, and whether the click was a Cmd-click (open it in the normal reader instead of another column).
    /// Lite boxes only; the full reader page keeps its own behaviour for the same link.
    var onSessionLink: ((String, Bool) -> Void)?
    /// A link in a lite page to a conversation in Campus's own web app (`https://<campus>/spaces/<kind>/<folder>/conversations/<id>`): taken before it
    /// leaves Conn, and opened by the Watch column rule (a Cmd-click opens the normal view). `campusHost` is Campus's host; nil takes no such link.
    let campusHost: String?
    var onCampusLink: ((_ kind: String, _ folder: String, _ id: String, _ command: Bool) -> Void)?
    private var useProxy: UseMessageProxy?
    private var linkProxy: SessionLinkProxy?
    /// Set by `release()`: a released box never loads or shows anything again.
    private(set) var released = false
    /// The addresses of Conn's panes by name, so a link between them can be told from one that leaves Conn.
    var paneAddresses: () -> [String: URL] = { [:] }
    /// A link that points at another Conn pane: switch to it and show that address.
    var showInPane: ((WebKind, URL) -> Void)?
    /// A link that leaves Conn. A test replaces it with a recorder so a check never opens a browser.
    var openInBrowser: (URL) -> Void = { NSWorkspace.shared.open($0) }

    init(kind: WebKind, baseURL: URL, fixtureDir: URL?, lite: Bool = false, startFragment: String? = nil, campusHost: String? = nil) {
        self.campusHost = campusHost
        self.kind = kind
        self.baseURL = baseURL
        self.fixtureDir = fixtureDir
        self.lite = lite
        self.startFragment = startFragment
        let cfg = WKWebViewConfiguration()
        if kind == .reader { cfg.userContentController.addUserScript(WKUserScript(source: WebBox.listenerWatch, injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
        let proxy = lite ? UseMessageProxy() : nil
        if let proxy = proxy {
            cfg.userContentController.addUserScript(WKUserScript(source: WebBox.useWatch, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            cfg.userContentController.add(proxy, name: WebBox.useMessage)
        }
        let links = lite ? SessionLinkProxy() : nil
        if let links = links {
            cfg.userContentController.addUserScript(WKUserScript(source: WebBox.sessionLinkScript(campusHost: campusHost), injectionTime: .atDocumentStart, forMainFrameOnly: true))
            cfg.userContentController.add(links, name: WebBox.sessionLinkMessage)
        }
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        proxy?.box = self
        useProxy = proxy
        links?.box = self
        linkProxy = links
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        urlObservation = webView.observe(\.url, options: [.initial, .new]) { [weak self] web, _ in
            let shown = StarSelection.sessionPrefix(inFragment: web.url?.fragment)
            DispatchQueue.main.async { if let self = self, self.shownSession != shown { self.shownSession = shown } }
        }
    }

    var pid: Int32? { (webView.value(forKey: "_webProcessIdentifier") as? Int).map { Int32($0) } }

    func loadIfNeeded() {
        guard phase == .idle, !released else { return }
        if let f = startFragment { loadFragment(f) } else { load(baseURL) }
    }

    func load(_ url: URL) {
        phase = .loading
        loadStart = Date()
        if let dir = fixtureDir, url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: dir) } else { webView.load(URLRequest(url: url)) }
    }

    func reload() {
        phase = .loading; loadStart = Date()
        if webView.url == nil { if let f = startFragment { loadFragment(f) } else { load(baseURL) } } else { webView.reload() }
    }

    // MARK: a Watch column

    static let useMessage = "connUse"
    /// Tells Conn that the person used the page: a click, a wheel or trackpad scroll, a key, or focus moving into it. Events the
    /// page makes itself (a scroll to a reply) are none of these. At most one message every 200 ms.
    static let useWatch = """
    (function () {
      if (window.__connUse) return;
      window.__connUse = true;
      var last = 0;
      function used() {
        var now = Date.now();
        if (now - last < 200) return;
        last = now;
        try { window.webkit.messageHandlers.\(useMessage).postMessage(1); } catch (e) {}
      }
      ['pointerdown', 'wheel', 'keydown', 'focusin'].forEach(function (t) { window.addEventListener(t, used, { capture: true, passive: true }); });
    })();
    """

    static let sessionLinkMessage = "connSession"
    /// A click on a session link (`a[data-session="<reader session id>"]`) is taken before the page sees it: the page does not
    /// navigate, and Conn is told which session the link names and whether Cmd was held. Capture phase on the window, so no handler of
    /// the page runs for that click and the page itself is not edited. The keyboard (Enter on a focused link) and a middle click arrive
    /// the same way. Only the Watch columns get this script; the full reader page is left alone.
    static let sessionLinkWatch = sessionLinkScript(campusHost: nil)

    /// The same capture-phase handler also takes a link to a conversation in Campus's own web app (`https://<campus host>/spaces/<kind>/<folder>/conversations/<id>`,
    /// when Campus is part of this launch): the page does not navigate, and Conn is told the address and whether Cmd was held. Conn checks the address again
    /// (`CampusClient.conversationLink`) before it opens anything.
    static func sessionLinkScript(campusHost: String?) -> String {
        let host = (campusHost ?? "").replacingOccurrences(of: "\\", with: "").replacingOccurrences(of: "'", with: "")
        return """
        (function () {
          if (window.__connSessionLinks) return;
          window.__connSessionLinks = true;
          var CAMPUS_HOST = '\(host)';
          function taken(e) {
            var t = e.target;
            var a = t && t.closest ? t.closest('a[data-session]') : null;
            var s = a && a.getAttribute('data-session');
            if (s) {
              e.preventDefault();
              e.stopImmediatePropagation();
              try { window.webkit.messageHandlers.\(sessionLinkMessage).postMessage({ session: s, reader: !!e.metaKey }); } catch (x) {}
              return;
            }
            if (!CAMPUS_HOST) return;
            var l = t && t.closest ? t.closest('a[href]') : null;
            if (!l) return;
            var u; try { u = new URL(l.href, location.href); } catch (x) { return; }
            if (u.hostname !== CAMPUS_HOST || !/\\/spaces\\/(private|team)\\/[^\\/]+\\/conversations\\/[^\\/]+/.test(u.pathname)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            try { window.webkit.messageHandlers.\(sessionLinkMessage).postMessage({ campus: u.href, reader: !!e.metaKey }); } catch (x) {}
          }
          window.addEventListener('click', function (e) { if (e.button === 0) taken(e); }, true);
          window.addEventListener('auxclick', function (e) { if (e.button === 1) taken(e); }, true);
        })();
        """
    }

    /// Show a conversation in this column: at its newest turn, or at one turn (the lite page scrolls to that reply and outlines it).
    /// With `reload` false and the page already showing, only the address changes (the page follows it in place, so the column keeps
    /// its scroll in everything else). With `reload` true, or when the page is not ready or does not follow an address change, the
    /// page loads again: a column that moves to another session must not keep the old conversation in memory.
    func showConversation(_ sid: String, message: String?, reload: Bool) {
        guard let frag = WatchAddress.fragment(session: sid, message: message) else { return }
        if phase == .idle { startFragment = frag; return }
        guard !reload, phase == .ready, WebLinkPolicy.isPage(baseURL, webView.url) else { loadFragment(frag); return }
        webView.evaluateJavaScript("window.\(WebBox.listenerFlag) === true") { [weak self] follows, _ in
            guard let self = self else { return }
            guard (follows as? Bool) == true, self.phase == .ready, WebLinkPolicy.isPage(self.baseURL, self.webView.url) else { self.loadFragment(frag); return }
            self.webView.evaluateJavaScript("location.hash='\(frag)'") { [weak self] _, error in
                guard let self = self else { return }
                if error != nil { self.loadFragment(frag) } else { self.pinsInPlace += 1 }
            }
        }
    }

    /// Let go of the page: stop loading, drop the delegates and take the web view out of its window, so the web content process
    /// can end. The box is not used again.
    func release() {
        released = true
        urlObservation?.invalidate(); urlObservation = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        if lite {
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebBox.useMessage)
            webView.configuration.userContentController.removeScriptMessageHandler(forName: WebBox.sessionLinkMessage)
        }
        useProxy = nil
        linkProxy = nil
        onUse = nil
        onSessionLink = nil
        onCampusLink = nil
    }

    /// Written into the reader page before its own scripts run: it records that the page listens for an address change
    /// (`hashchange`), which is how Conn tells a reader that follows `#s=` while open from an older one that reads it only
    /// at load. Nothing in the page is edited; the page's own `addEventListener` still runs.
    static let listenerFlag = "__connFollowsAddress"
    static let listenerWatch = """
    (function () {
      if (window.\(listenerFlag) !== undefined) return;
      window.\(listenerFlag) = false;
      var add = window.addEventListener;
      window.addEventListener = function (type) { if (type === 'hashchange') window.\(listenerFlag) = true; return add.apply(this, arguments); };
    })();
    """

    /// How many pins were answered by changing the address in place, and how many by loading the page (test hooks).
    private(set) var pinsInPlace = 0
    private(set) var pinsLoaded = 0

    /// Open the reader on one conversation, or on one reply in it (`message`: the reader's address `#s=<session>&m=<reply>`, which
    /// scrolls to that reply and flashes it once). When the page on screen is the reader and it follows an address change while open
    /// (it says so by listening for `hashchange`), only the address fragment changes and the reader switches in place: no page
    /// load, no 19 MB download, the scroll place of the others kept. Otherwise the page is loaded: the first load, another
    /// page or server, an older reader that reads `#s=` only at load, or an in-place change that fails.
    func pin(sessionID: String?, message: String? = nil) {
        guard kind == .reader, let sid = sessionID, sid.range(of: "^[A-Za-z0-9-]{1,64}$", options: .regularExpression) != nil else { return }
        // A reply id that is not one the reader would follow is left out: the session still opens, at its newest turn.
        let reply = message.flatMap { OpenAsk.validMessage($0) ? $0 : nil }
        let fragment = "s=\(sid)" + (reply.map { "&m=\($0)" } ?? "")
        guard phase == .ready, WebLinkPolicy.isPage(baseURL, webView.url) else { loadFragment(fragment); return }
        webView.evaluateJavaScript("window.\(WebBox.listenerFlag) === true") { [weak self] follows, _ in
            guard let self = self else { return }
            // The page may have started another load while the question was in flight.
            guard (follows as? Bool) == true, self.phase == .ready, WebLinkPolicy.isPage(self.baseURL, self.webView.url) else { self.loadFragment(fragment); return }
            self.webView.evaluateJavaScript("location.hash='\(fragment)'") { [weak self] _, error in
                guard let self = self else { return }
                if error != nil { self.loadFragment(fragment) } else { self.pinsInPlace += 1 }
            }
        }
    }

    /// The pin as a page load. A live page gets a `?conn=<n>` query so WKWebView treats it as a new document and not as a
    /// fragment jump; a fixture file takes the hash once it has loaded.
    private func loadFragment(_ fragment: String) {
        pinsLoaded += 1
        if fixtureDir != nil { pendingHash = fragment; load(baseURL); return }
        pinCounter += 1
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "conn", value: "\(pinCounter)")]
        comps.fragment = fragment
        if let url = comps.url { load(url) }
    }

    /// Ask the reader for its open asks from inside the page. The reader's routes need the per-start token, which the reader writes
    /// into the page it serves to a browser tab (`<meta name="reader-token">`) and hands out nowhere else, so the question goes
    /// out the way the page's own scripts send theirs: same origin, token header. nil when the reader page is not loaded (or is
    /// not the reader's), carries no token, or answers anything but 200 (404 `not_built` before the first build, an older reader,
    /// 403, 5xx), when the answer is not JSON, or after 3 seconds. Never throws.
    static let openAsksScript = """
    const meta = document.querySelector('meta[name="reader-token"]');
    const token = meta && meta.content;
    if (!token || token === '__READER_TOKEN__') return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(path, { headers: { 'x-transcript-reader-token': token, 'Accept': 'application/json' }, cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      return r.status === 200 ? await r.text() : null;
    } catch (e) { return null; } finally { clearTimeout(timer); }
    """

    /// The question put to one web view that shows a page of the reader's server (the full page, or any page on that origin: the
    /// reader's lite pages carry the same token meta). nil when the view is loading, shows nothing or another origin's page,
    /// or the script finds no token or no good answer.
    @MainActor
    static func readOpenAsks(from web: WKWebView, readerBase: URL) async -> OpenAsksFeed? {
        guard !web.isLoading, let shown = web.url, WebLinkPolicy.sameOrigin(readerBase, shown) else { return nil }
        let result = try? await web.callAsyncJavaScript(WebBox.openAsksScript, arguments: ["path": OpenAsksSource.path], in: nil, contentWorld: .page)
        return (result as? String).flatMap { $0.data(using: .utf8) }.flatMap(OpenAsksFeed.parse)
    }

    @MainActor
    func fetchOpenAsks() async -> OpenAsksFeed? {
        guard kind == .reader, fixtureDir == nil, phase == .ready else { return nil }
        return await WebBox.readOpenAsks(from: webView, readerBase: baseURL)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        phase = .ready
        title = webView.title ?? ""
        if let s = loadStart { loadSeconds = Date().timeIntervalSince(s) }
        if let h = pendingHash { pendingHash = nil; webView.evaluateJavaScript("location.hash='\(h)'", completionHandler: nil) }
        if kind == .organizer { showContextView() }
    }

    // MARK: the organizer opens on its Context view

    /// The organizer page starts on its Restart view and has no memory of a chosen view, so Conn selects the Context view
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

    // MARK: links between Conn's panes

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

    /// `target=_blank` and `window.open` ask for a new window; Conn has none, so the link is routed like any other and no
    /// web view is created (returning nil refuses the new window).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            let route = WebLinkPolicy.route(for: url, ownBase: baseURL, panes: paneAddresses())
            handle(route == .allow ? (url.scheme == "http" || url.scheme == "https" ? .showInPane(pane: kind.rawValue, url: url) : .allow) : route)
        }
        return nil
    }

    /// A load that another load replaced (a pin right after the page opened, a column moving to another session) reports "cancelled".
    /// That is not a failure: the page that replaced it is on its way, and showing "not reachable" in between would be wrong (ROADMAP N2).
    private func failed(_ error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        phase = .failed(error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

    /// A link to the other Conn pane switches to it (exact address, hash kept); any other link that leaves the page opens in
    /// the default browser instead of replacing the pane. Links inside the page, and everything that is not a click, load as usual.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if lite, action.navigationType == .linkActivated, let url = action.request.url, let host = campusHost,
           let ref = CampusClient.conversationLink(url, campusHost: host) {
            decisionHandler(.cancel)
            let command = action.modifierFlags.contains(.command)
            DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.onCampusLink?(ref.kind, ref.folder, ref.id, command) } }
            return
        }
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

/// Receives the page's "used" message without keeping the box alive (the user content controller holds its handlers strongly).
private final class UseMessageProxy: NSObject, WKScriptMessageHandler {
    weak var box: WebBox?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        DispatchQueue.main.async { [weak self] in self?.box?.onUse?() }
    }
}

/// Receives a session link click from a Watch column without keeping the box alive. A session id the lite page would not open is dropped.
private final class SessionLinkProxy: NSObject, WKScriptMessageHandler {
    weak var box: WebBox?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        let reader = body["reader"] as? Bool ?? false
        if let href = body["campus"] as? String {
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let box = self?.box, let host = box.campusHost, let url = URL(string: href), let ref = CampusClient.conversationLink(url, campusHost: host) else { return }
                    box.onCampusLink?(ref.kind, ref.folder, ref.id, reader)
                }
            }
            return
        }
        guard let session = body["session"] as? String, WatchAddress.validSession(session) else { return }
        DispatchQueue.main.async { [weak self] in self?.box?.onSessionLink?(session, reader) }
    }
}

final class WebHub {
    let fixture: Bool
    let resourceDir: URL?
    private(set) var readerBox: WebBox?
    private(set) var organizerBox: WebBox?
    /// A link in one pane points at the other: the app switches tabs and has the box show the address.
    var onShowPane: ((WebKind, URL) -> Void)?

    /// A test's stand-in reader: the address the Reader pane (and the asks) use instead of `CONN_READER_URL`.
    private let readerURL: URL?

    init(fixture: Bool, resourceDir: URL?, readerURL: URL? = nil) { self.fixture = fixture; self.resourceDir = resourceDir; self.readerURL = readerURL }

    /// Where each pane's page lives (the same addresses `make` loads).
    func baseURL(_ kind: WebKind) -> URL {
        if fixture, let dir = resourceDir { return dir.appendingPathComponent(kind == .reader ? "fixture-reader.html" : "fixture-organizer.html") }
        if kind == .reader, let u = readerURL { return u }
        let env = ProcessInfo.processInfo.environment
        let reader = env["CONN_READER_URL"] ?? "http://localhost:8768/setup/transcript-reader/out/prototype.html"
        let organizer = env["CONN_ORGANIZER_URL"] ?? "http://localhost:8765/apps/wip-herdr-workspace-organizer.html"
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

    /// The web views of the lite pages (a Watch view's columns) that show pages of the reader's server while the full Reader page is
    /// unloaded. nil: Watch is off, so Conn may load the full Reader page itself to ask. A list, even an empty one: Watch is on, and
    /// Conn asks these views and never loads the full page just to ask.
    var extraReaderPages: () -> [WKWebView]? = { nil }

    /// The reader's open asks, asked from whichever web view of the reader's server is loaded: the full Reader page first, then
    /// `extraReaderPages`. The first good answer wins. With none loaded and Watch off, the full page is loaded in the background
    /// (asked again on the next beat): a live Conn has to hold a reader page to hold its token. nil: no asks.
    @MainActor
    func fetchOpenAsks() async -> OpenAsksFeed? {
        let base = baseURL(.reader)
        let extra = extraReaderPages()
        var views: [WKWebView] = []
        if let box = readerBox, box.phase == .ready { views.append(box.webView) }
        views += extra ?? []
        for v in views { if let feed = await WebBox.readOpenAsks(from: v, readerBase: base) { return feed } }
        if extra == nil { box(.reader).loadIfNeeded() }
        return nil
    }

    /// The reader's lite page, which a Watch column shows one conversation on (reader README, "The lite page"). `CONN_LITE_URL` names
    /// another address; a fixture launch loads an invented page instead.
    var liteBaseURL: URL {
        if fixture, let dir = resourceDir { return dir.appendingPathComponent("fixture-lite.html") }
        let env = ProcessInfo.processInfo.environment
        return URL(string: env["CONN_LITE_URL"] ?? "http://localhost:8768/setup/transcript-reader/out/live/index.html")!
    }

    /// The reader's embed page, which a Campus conversation in the Reader column or a Watch column is drawn on (`CampusEmbedBox`). `CONN_EMBED_URL` names another address
    /// (a file for a check); an invented (`--fixture`) launch asks nothing of the real reader, so without it there is no page and the native transcript stays. nil: none.
    var embedURL: URL? {
        if let e = ProcessInfo.processInfo.environment["CONN_EMBED_URL"], !e.isEmpty { return URL(string: e) }
        return fixture ? nil : URL(string: CampusEmbed.servedAddress)
    }

    /// A web view for one Watch column. It is not one of the two panes: a link that leaves the page goes to the browser (a column
    /// has no pane to switch to), and the box is dropped when Watch ends.
    func makeLiteBox(startFragment: String?) -> WebBox {
        WebBox(kind: .reader, baseURL: liteBaseURL, fixtureDir: fixture ? resourceDir : nil, lite: true, startFragment: startFragment, campusHost: campusHost)
    }

    /// Campus's host, so a lite page's link to a Campus conversation is told from any other link.
    var campusHost: String?

    /// Watch unloads the full reader: its page holds every conversation and document (255 to 430 MB or more), which three or four
    /// columns of the lite page replace. The box is made again, and the page loaded again, the next time the Reader pane shows.
    func evictReader() {
        readerBox?.release()
        readerBox = nil
    }
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
