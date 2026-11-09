// Campus sign-in, the cookie way (decision C8): the person signs in to Campus inside Conn (Google sign-in in a Conn web view), and every
// Campus API call then runs same-origin from inside a hidden, signed-in web view. The `campus_session` cookie is HttpOnly and stays in
// WebKit's own cookie store: Conn's code only ever receives a status, JSON text and event text, and never reads, prints, logs, stores
// or copies a cookie or a token. `CampusAuth` (ConnCore) is the one seam, so an API key can replace this file's class later without
// touching a view.
//
// Two web views share one website data store: the API view (never shown; sits on a light page of Campus's origin so `fetch` is same-origin)
// and the sign-in view (shown in a sheet on the login page). A scripted launch uses a non-persistent store, so a check never reads or
// changes the cookies of a person's own sign-in.
//
// The sign-in view also reports what the network does with Campus: Campus answers only on the company private network, and off it a public ingress answers every
// path with nginx's `403 Forbidden` page. A main-frame 403 (or a failed load) on Campus's own host is not shown as that page: the sheet says it is the network
// (`signInRefused`), with a Try again. Each hop (time, host, path, status; never a query, cookie or token) goes to `hops`.
import SwiftUI
import WebKit
import ConnCore

@MainActor
final class CampusWebAuth: NSObject, ObservableObject, CampusAuth, WKNavigationDelegate, WKUIDelegate {
    let origin: URL
    var kind: String { "cookie" }
    let apiView: WKWebView
    let signInView: WKWebView
    /// The one cookie store the API view, the sign-in view and the silent refresh's hidden view share.
    let store: WKWebsiteDataStore
    /// The store shows the sign-in sheet.
    var onSignIn: (() -> Void)?
    /// The sign-in sheet's last main-frame answer from Campus's own host was a refusal (a 403, or a load that failed): the sheet says so instead of showing the raw page.
    @Published private(set) var signInRefused = false
    /// Where each hop of the sign-in sheet is logged (nil: not logged).
    var hops: CampusHopLog?
    private var loaded = false
    private var loading: Task<Void, Never>?
    private var streams: [Int: AsyncStream<CampusStreamEvent>.Continuation] = [:]
    private var streamCounter = 0
    private var proxy: CampusStreamProxy?
    static let streamMessage = "connCampusStream"

    init(origin: URL, persistent: Bool) {
        self.origin = origin
        let store: WKWebsiteDataStore = persistent ? .default() : .nonPersistent()
        self.store = store
        func config() -> WKWebViewConfiguration { let c = WKWebViewConfiguration(); c.websiteDataStore = store; return c }
        let apiCfg = config()
        let proxy = CampusStreamProxy()
        apiCfg.userContentController.add(proxy, name: CampusWebAuth.streamMessage)
        apiView = WKWebView(frame: CGRect(x: 0, y: 0, width: 400, height: 300), configuration: apiCfg)
        signInView = WKWebView(frame: .zero, configuration: config())
        super.init()
        self.proxy = proxy
        proxy.auth = self
        apiView.navigationDelegate = self
        signInView.navigationDelegate = self
        signInView.uiDelegate = self
        apiView.allowsBackForwardNavigationGestures = false
    }

    // MARK: requests

    /// The page the API view sits on: a small JSON document of Campus's own origin, so a relative `fetch` is same-origin and carries the cookie.
    private var basePage: URL { origin.appendingPathComponent("campus/api/me") }

    private func ensureLoaded() async {
        if loaded { return }
        if let t = loading { await t.value; return }
        let t = Task { @MainActor in
            self.apiView.load(URLRequest(url: self.basePage))
            var waited = 0.0
            while !self.loaded && waited < 10 { try? await Task.sleep(nanoseconds: 50_000_000); waited += 0.05 }
        }
        loading = t
        await t.value
        loading = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { if webView === apiView { loaded = true } }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFailed(webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFailed(webView, error) }

    private func loadFailed(_ webView: WKWebView, _ error: Error) {
        if webView === apiView { loaded = false }
        guard webView === signInView else { return }
        // A navigation that was cancelled (our own stop of the 403 page, or the next one replacing it) is not a failed load.
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
        let failing = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? (e.userInfo[NSURLErrorFailingURLStringErrorKey] as? String).flatMap(URL.init(string:))
        guard isCampus(failing) || (failing == nil && isCampus(webView.url)), let url = failing ?? webView.url else { return }
        hops?.append(CampusHop(at: Date(), source: "sign-in", url: url, status: 0))
        signInRefused = true
    }

    /// Google's sign-in may ask for a new window: it opens in the sign-in view itself (Conn has no other window).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }

    static let requestScript = """
    try {
      const init = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
      if (body !== null) init.body = body;
      const r = await fetch(path, init);
      const text = await r.text();
      const type = r.headers.get('content-type') || '';
      const login = (r.redirected && /\\/login/.test(r.url)) || (r.ok && type.indexOf('json') < 0 && /<html/i.test(text.slice(0, 600)));
      return { status: r.status, body: text, login: !!login };
    } catch (e) { return { status: 0, body: '', login: false }; }
    """

    func perform(_ r: CampusRequest) async -> CampusReply? {
        await ensureLoaded()
        guard loaded else { return nil }
        let args: [String: Any] = ["method": r.method, "path": r.path, "headers": r.headers, "body": r.body.flatMap { String(data: $0, encoding: .utf8) } ?? NSNull()]
        let result = try? await apiView.callAsyncJavaScript(CampusWebAuth.requestScript, arguments: args, in: nil, contentWorld: .page)
        guard let o = result as? [String: Any], let status = o["status"] as? Int, status > 0 else { return nil }
        return CampusReply(status: status, body: Data(((o["body"] as? String) ?? "").utf8), loginRedirect: (o["login"] as? Bool) ?? false)
    }

    // MARK: the event stream

    static let streamScript = """
    window.__connCampusStream = async function (id, path) {
      const post = function (o) { try { window.webkit.messageHandlers.connCampusStream.postMessage(Object.assign({ id: id }, o)); } catch (e) {} };
      const ctl = new AbortController();
      window.__connCampusAbort = ctl;
      try {
        const r = await fetch(path, { headers: { 'Accept': 'text/event-stream' }, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
        post({ kind: 'opened', status: r.status });
        if (!r.ok || !r.body) {
          // A 403 whose body is Campus's own JSON error (a module refusal, or another named error) is a refusal; any other body (nginx's page) is the network refusing the
          // connection. The close says which, as words after the status.
          let why = 'status ' + r.status;
          if (r.status === 403) {
            try {
              const t = await r.text();
              let j = null; try { j = JSON.parse(t); } catch (e) {}
              if (j && typeof j === 'object') { why += ' json'; if (t.indexOf('module_required') >= 0) why += ' module_required'; }
            } catch (e) {}
          }
          post({ kind: 'closed', why: why }); return;
        }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          post({ kind: 'text', text: dec.decode(part.value, { stream: true }) });
        }
        post({ kind: 'closed', why: 'ended' });
      } catch (e) { post({ kind: 'closed', why: String((e && e.name) || e) }); }
    };
    """

    func openEventStream() -> AsyncStream<CampusStreamEvent> {
        streamCounter += 1
        let id = streamCounter
        return AsyncStream { cont in
            Task { @MainActor in
                await self.ensureLoaded()
                guard self.loaded else { cont.yield(.closed("no page")); cont.finish(); return }
                self.streams[id] = cont
                _ = try? await self.apiView.evaluateJavaScript(CampusWebAuth.streamScript)
                _ = try? await self.apiView.evaluateJavaScript("(function(){ window.__connCampusStream(\(id), '/api/events'); return 1; })()")
            }
            cont.onTermination = { _ in Task { @MainActor in self.endStream(id, abort: true) } }
        }
    }

    func closeEventStream() {
        for id in streams.keys { endStream(id, abort: true) }
    }

    private func endStream(_ id: Int, abort: Bool) {
        guard let c = streams.removeValue(forKey: id) else { return }
        if abort { apiView.evaluateJavaScript("(function(){ if (window.__connCampusAbort) window.__connCampusAbort.abort(); return 1; })()", completionHandler: nil) }
        c.yield(.closed(nil)); c.finish()
    }

    fileprivate func received(_ body: [String: Any]) {
        guard let id = body["id"] as? Int, let c = streams[id], let kind = body["kind"] as? String else { return }
        switch kind {
        case "opened": c.yield(.opened((body["status"] as? Int) ?? 0))
        case "text": if let t = body["text"] as? String { c.yield(.text(t)) }
        case "closed": c.yield(.closed(body["why"] as? String)); c.finish(); streams[id] = nil
        default: break
        }
    }

    // MARK: sign-in

    func beginSignIn() {
        signInRefused = false
        signInView.load(URLRequest(url: origin.appendingPathComponent("campus/login")))
        onSignIn?()
    }

    /// "Try again" in the sheet: load the sign-in page afresh.
    func retrySignIn() {
        signInRefused = false
        signInView.load(URLRequest(url: origin.appendingPathComponent("campus/login")))
    }

    private func isCampus(_ url: URL?) -> Bool { url?.host?.lowercased() == origin.host?.lowercased() }

    /// Each main-frame answer of the sign-in sheet is logged (host, path, status). A 403 from Campus's own host is nginx's refusal, not a page to show: the load is stopped
    /// and the sheet says it is the network.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard webView === signInView, navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse, let url = http.url else { decisionHandler(.allow); return }
        hops?.append(CampusHop(at: Date(), source: "sign-in", url: url, status: http.statusCode))
        if isCampus(url), http.statusCode == 403 {
            signInRefused = true
            decisionHandler(.cancel)
            return
        }
        if isCampus(url), http.statusCode < 400, signInRefused { signInRefused = false }
        decisionHandler(.allow)
    }
}

/// Receives the stream's text from the API view without keeping the auth alive (the content controller holds its handlers strongly).
private final class CampusStreamProxy: NSObject, WKScriptMessageHandler {
    weak var auth: CampusWebAuth?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        DispatchQueue.main.async { [weak self] in MainActor.assumeIsolated { self?.auth?.received(body) } }
    }
}

/// The sign-in sheet's web view: Conn's own view on Campus's login page.
struct CampusSignInWeb: NSViewRepresentable {
    let web: WKWebView
    func makeNSView(context: Context) -> WKWebView { web }
    func updateNSView(_ v: WKWebView, context: Context) {}
}
