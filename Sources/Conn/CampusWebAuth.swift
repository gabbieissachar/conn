// Campus sign-in, the cookie way (decision C8): the person signs in to Campus inside Conn (Google sign-in in a Conn web view), and every
// Campus API call then runs same-origin from inside a hidden, signed-in web view. The `campus_session` cookie is HttpOnly and stays in
// WebKit's own cookie store: Conn's code only ever receives a status, JSON text and event text, and never reads, prints, logs, stores
// or copies a cookie or a token. `CampusAuth` (ConnCore) is the one seam, so an API key can replace this file's class later without
// touching a view.
//
// Two web views share one website data store: the API view (never shown; sits on a light page of Campus's origin so `fetch` is same-origin)
// and the sign-in view (shown in a sheet on the login page). A scripted launch uses a non-persistent store, so a check never reads or
// changes the cookies of a person's own sign-in.
import SwiftUI
import WebKit
import ConnCore

@MainActor
final class CampusWebAuth: NSObject, CampusAuth, WKNavigationDelegate, WKUIDelegate {
    let origin: URL
    var kind: String { "cookie" }
    let apiView: WKWebView
    let signInView: WKWebView
    /// The one cookie store the API view, the sign-in view and the silent refresh's hidden view share.
    let store: WKWebsiteDataStore
    /// The store shows the sign-in sheet.
    var onSignIn: (() -> Void)?
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
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { if webView === apiView { loaded = false } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if webView === apiView { loaded = false } }

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
          // A 403 that names a module is a refusal, not a sign-out: the close says so (Campus's JSON error body, read as text).
          let why = 'status ' + r.status;
          if (r.status === 403) { try { if ((await r.text()).indexOf('module_required') >= 0) why += ' module_required'; } catch (e) {} }
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

    func beginSignIn() { signInView.load(URLRequest(url: origin.appendingPathComponent("campus/login"))); onSignIn?() }
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
