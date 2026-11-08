// The web side of the silent Campus session refresh (J7=a; the rules and the loop are `CampusRenewal.swift` in ConnCore).
//
// Reading the session's end: the cookie store of Conn's own sign-in web views is asked for `campus_session`, and the `exp` of that token (an HttpOnly Google ID
// token) is read in this process and dropped. Only the date is kept. The token and the cookie are never logged, printed, stored or copied.
//
// The attempt: a new, hidden web view (never in a window, so it cannot show or take focus) on the same cookie store loads Campus's own sign-in path. It does not
// click, type, run script in, or answer anything: no `evaluateJavaScript`, no form, no key. It reports where it stood still:
//   - a page of Campus's own that is not its login: signed in again (the keeper then checks the session ends later);
//   - Campus's login page, or any other site (Google's account chooser or password page), that stays after the page settled for `settleDelay` seconds with no new
//     navigation: a page that waits for the person, so the attempt stops there and the view is dropped;
//   - a popup, a script dialog, a credential challenge or a media request: also a page that waits for the person (the request is declined, not answered);
//   - nothing within the timeout, or a load that failed.
// Redirects that pass through another site on the way back to Campus (no page of theirs finishes loading and stays) are what a silent renewal looks like, so they
// are let through.
import SwiftUI
import WebKit
import ConnCore

@MainActor
final class CampusSilentRenewal: NSObject, CampusRenewing, WKNavigationDelegate, WKUIDelegate {
    let origin: URL
    private let store: WKWebsiteDataStore
    /// Seconds a login page or another site must stay with no new navigation before it counts as waiting for the person.
    var settleDelay: TimeInterval = 2.5
    private var view: WKWebView?
    private var run: Run?
    /// How many hidden views were made (a check reads it).
    private(set) var attempts = 0

    /// A hidden attempt is under way.
    var isAttempting: Bool { run != nil }
    /// While an attempt is under way: whether its web view sits in a window (it never does). nil when none is.
    var hiddenViewHasWindow: Bool? { view.map { $0.window != nil } }

    /// One attempt's state, read by the delegate callbacks.
    private final class Run {
        var settled: CampusRenewalPage?
        var failed = false
        var done = false
        var token = 0
    }

    init(origin: URL, store: WKWebsiteDataStore) {
        self.origin = origin; self.store = store
    }

    // MARK: the session's end

    func sessionExpiry() async -> Date? {
        guard let host = origin.host?.lowercased() else { return nil }
        var best: Date?
        for c in await store.httpCookieStore.allCookies() where c.name == "campus_session" && Self.domain(c.domain, covers: host) {
            // The token is read here and goes no further than this line: only its date leaves.
            guard let exp = CampusSessionToken.expiry(of: c.value) ?? c.expiresDate else { continue }
            if best == nil || exp > best! { best = exp }
        }
        return best
    }

    /// A cookie's domain covers a host when it is that host, or a parent of it written with or without the leading dot.
    nonisolated static func domain(_ cookieDomain: String, covers host: String) -> Bool {
        let d = cookieDomain.lowercased().drop { $0 == "." }
        return host == d || host.hasSuffix("." + d)
    }

    // MARK: the attempt

    func attemptRenewal(timeout: TimeInterval) async -> CampusRenewalResult {
        guard run == nil else { return CampusRenewalResult(failed: true) }
        let r = Run()
        run = r
        attempts += 1
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = store
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 480, height: 640), configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        view = web
        web.load(URLRequest(url: origin.appendingPathComponent("campus/login")))
        var waited = 0.0
        while !r.done && waited < timeout { try? await Task.sleep(nanoseconds: 50_000_000); waited += 0.05 }
        let timedOut = !r.done
        r.done = true
        web.navigationDelegate = nil
        web.uiDelegate = nil
        web.stopLoading()
        view = nil
        run = nil
        return CampusRenewalResult(settled: timedOut ? nil : r.settled, timedOut: timedOut, failed: r.failed)
    }

    private func finish(_ page: CampusRenewalPage) {
        guard let r = run, !r.done else { return }
        r.settled = page
        r.done = true
    }

    // MARK: navigation

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let r = run, !r.done else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame != false {
            r.token += 1                                             // a new navigation: whatever was waiting to settle did not
            if let url = navigationAction.request.url, !["http", "https", "about"].contains(url.scheme?.lowercased() ?? "") {
                // Another app's address (a custom scheme): nothing Conn can follow on its own.
                decisionHandler(.cancel)
                finish(.elsewhere)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let r = run, !r.done, let url = webView.url, let host = origin.host else { return }
        switch CampusRenewalRules.page(for: url, campusHost: host) {
        case .campus:
            finish(.campus)
        case let page:
            // A page that finished loading and then goes nowhere is waiting for the person. One that moves on within the settle time (a script's redirect) is not.
            r.token += 1
            let mine = r.token
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64((self?.settleDelay ?? 2.5) * 1_000_000_000))
                guard let self = self, let r = self.run, r.token == mine, !r.done else { return }
                self.finish(page)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loadFailed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loadFailed(error) }

    private func loadFailed(_ error: Error) {
        // A navigation replaced by the next one (a redirect's own bookkeeping, or our cancel) is not a failure.
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
        guard let r = run, !r.done else { return }
        r.failed = true
        r.done = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let r = run, !r.done else { return }
        r.failed = true
        r.done = true
    }

    /// A server certificate is judged the usual way; anything else that asks for a name and password (or a certificate of the person's) waits for the person.
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            finish(.elsewhere)
        }
    }

    // MARK: things a page may ask for: none is answered

    /// A popup (Google's sign-in may open one): not opened; the page needed the person.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        finish(.elsewhere)
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        completionHandler(); finish(.elsewhere)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(false); finish(.elsewhere)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        completionHandler(nil); finish(.elsewhere)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil); finish(.elsewhere)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny); finish(.elsewhere)
    }
}
