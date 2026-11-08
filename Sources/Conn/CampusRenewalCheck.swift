// `--ui-check` steps for the silent Campus session refresh (J7=a), run by `CampusCheck` against the stand-in Campus: the keeper reads the session's end from the
// web view's cookie store, tries by itself once the end is within five minutes, a hidden web view (never in a window) goes through the stand-in's sign-in path, and
// each way it can end: renewed, sent to another site's account chooser, left on Campus's own login page, never answered. Nothing in the hidden view is clicked.
// The stand-in's token is an invented unsigned one whose first segment is a fixed marker; the checks look for it in everything Conn keeps. SwiftUI builds no
// accessibility tree for an inert background window, so the steps read the model; `CONN_UI_CHECK_SHOT_DIR` also writes a picture of the section.
import SwiftUI
import WebKit
import ConnCore

extension CampusCheck {
    static func renewalChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                              control: (String) async -> Void, js: (WKWebView, String) async -> String, shot: (String) async -> Void) async {
        let campus = model.campus
        guard let auth = model.campusAuth, let keeper = model.campusKeeper, let renewal = model.campusRenewal else { report("Campus refresh: the checks need the keeper", false, "no keeper"); return }
        let marker = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"
        model.watchOn = false; model.campusSelectedID = nil

        func stand(_ path: String) async -> CampusJSON? {
            guard let u = URL(string: path, relativeTo: campus.baseURL), let (d, _) = try? await URLSession.shared.data(from: u) else { return nil }
            return CampusJSON.parse(d)
        }
        func session() async -> (exp: Int, renewals: Int) {
            let j = await stand("/__fake/session")
            return (j?["exp"].int ?? 0, j?["renewals"].int ?? -1)
        }
        func writes() async -> Int { await stand("/__fake/log")?["writes"].array.count ?? -1 }
        func stamp(_ d: Date?) -> String { d.map { "\(Int($0.timeIntervalSince1970))" } ?? "-" }
        /// The person signs in by hand: the stand-in's login page, its click, the sheet closing. The new token lives `life` seconds; later ones live an hour. The
        /// keeper starts from its usual rule, and `then` is what the stand-in's sign-in path does from the moment the cookie is set.
        func signIn(life: Int, then mode: String = "page") async {
            keeper.planner = CampusRenewalPlanner()
            await control("/__fake/renew?mode=page")
            await control("/__fake/session-life?seconds=\(life)")
            model.signInToCampus()
            _ = await until(10) { auth.signInView.url?.path == "/campus/login" && !auth.signInView.isLoading }
            _ = await js(auth.signInView, "document.getElementById('go').click(); 'ok'")
            _ = await until(10) { auth.signInView.url?.path == "/campus/login/ok" && !auth.signInView.isLoading }
            await control("/__fake/session-life?seconds=3600")
            await control("/__fake/renew?mode=\(mode)")
            campus.kick()
            _ = await until(15) { campus.link == .live }
            _ = await until(8) { !model.campusSignInShown }
            if model.campusSignInShown { model.closeCampusSignIn() }
        }
        /// From now on a visit is due at once; what it meets is `mode`.
        func arm(_ mode: String) async {
            await control("/__fake/renew?mode=\(mode)")
            keeper.planner = CampusRenewalPlanner(lead: 100_000, retryAfter: 1000)
            keeper.nudge()
        }

        if campus.link != .live { await signIn(life: 3600) }
        keeper.planner = CampusRenewalPlanner()                                       // the real rule: five minutes before the end
        keeper.attemptTimeout = 25
        renewal.settleDelay = 0.4
        let windowsBefore = NSApp.windows.count

        // 1. The keeper knows when the session ends, from the cookie store of Conn's own web views.
        keeper.nudge()
        let truth = await session()
        let knew = await until(12) { keeper.expiry.map { Int($0.timeIntervalSince1970) } == truth.exp && truth.exp > 0 }
        report("Campus refresh: Conn reads when the session ends from its own web view's cookie store (the token's expiry), and keeps only that date",
               knew && !(String(describing: keeper.expiry as Any) + String(describing: keeper.lastAttempt as Any)).contains(marker),
               "keeper=\(stamp(keeper.expiry)) standIn=\(truth.exp)")

        // 2. A session with an hour left is left alone: nothing is tried now.
        let before = keeper.attemptCount
        keeper.nudge(); await wait(1.5)
        report("Campus refresh: with an hour left nothing is tried yet", keeper.attemptCount == before && !keeper.needsSignIn, "attempts=\(keeper.attemptCount)")

        // 3. Within five minutes of the end (a session that lives 250 s) Conn tries by itself once the sign-in sheet is closed, and the session then ends later.
        let renewalsBefore = (await session()).renewals
        await signIn(life: 250, then: "renews")
        let renewed = await until(30) { keeper.lastAttempt?.outcome == .renewed }
        let afterRenew = await session()
        let last = keeper.lastAttempt
        report("Campus refresh: within five minutes of the end Conn signs in again by itself in a hidden web view, and the session now ends later",
               renewed && afterRenew.renewals == renewalsBefore + 1 && (last?.newExpiry ?? .distantPast) > (last?.oldExpiry ?? .distantFuture) && keeper.expiry == last?.newExpiry && !keeper.needsSignIn && Int(last?.newExpiry?.timeIntervalSince1970 ?? 0) == afterRenew.exp,
               "outcome=\(last?.outcome.rawValue ?? "nil") renewals=\(afterRenew.renewals - renewalsBefore) old=\(stamp(last?.oldExpiry)) new=\(stamp(last?.newExpiry)) standIn=\(afterRenew.exp)")
        report("Campus refresh: the hidden attempt opened no sheet and no window, and the view is gone when it ends", !model.campusSignInShown && NSApp.windows.count == windowsBefore && !renewal.isAttempting && renewal.hiddenViewHasWindow == nil,
               "sheet=\(model.campusSignInShown) windows=\(NSApp.windows.count)/\(windowsBefore)")
        _ = await until(8) { campus.link == .live }
        report("Campus refresh: the Campus link stays live through a renewal and the rows are still read", campus.link == .live && campus.conversations.count >= 8, "link=\(campus.link) rows=\(campus.conversations.count)")

        // 4. The log: one line per attempt, dates and a word, no token and no cookie.
        let logText = (try? String(contentsOf: keeper.log!.file, encoding: .utf8)) ?? ""
        let settingsText = CampusSessionSettingsSection.lastText(keeper.lastAttempt)
        report("Campus refresh: each attempt is logged with its time, old and new expiry and outcome, and the log and the Settings line hold no token or cookie",
               logText.contains("\"outcome\":\"renewed\"") && logText.contains("oldExpiry") && !logText.contains(marker) && !logText.contains("campus_session") && settingsText.contains("renewed") && !settingsText.contains(marker),
               "log=\(logText.split(separator: "\n").count) lines settings='\(settingsText)'")
        await shot("campus-refresh-1-renewed.png")

        // 5. Another site's account chooser: stop at once, drop the view, say "sign in again"; nothing in that page is clicked.
        await signIn(life: 3600)
        let writesBefore = await writes()
        let attemptsBefore = keeper.attemptCount, renewalsMid = (await session()).renewals
        await arm("google")
        let said = await until(25) { keeper.needsSignIn }
        let afterGoogle = await session()
        report("Campus refresh: a redirect to another site's account chooser stops the attempt at once: the section says sign in again, nothing was renewed, the view is gone",
               said && keeper.lastAttempt?.outcome == .needsSignIn && keeper.attemptCount == attemptsBefore + 1 && afterGoogle.renewals == renewalsMid && !renewal.isAttempting && campus.link == .live && !model.campusSignInShown,
               "outcome=\(keeper.lastAttempt?.outcome.rawValue ?? "nil") needsSignIn=\(keeper.needsSignIn) link=\(campus.link)")
        await wait(2.5)
        let writesAfter = await writes()
        report("Campus refresh: it does not try again for the same session, and no click or write reached the stand-in", keeper.attemptCount == attemptsBefore + 1 && writesAfter == writesBefore, "attempts=\(keeper.attemptCount - attemptsBefore) writes=\(writesAfter)/\(writesBefore)")
        await shot("campus-refresh-2-sign-in-again.png")

        // 6. The normal Sign in action works from there, and a new sign-in clears the note by itself.
        await signIn(life: 3600)
        let cleared = await until(10) { !keeper.needsSignIn }
        report("Campus refresh: signing in by hand moves the session's end and clears the note", cleared && keeper.expiry != nil, "needsSignIn=\(keeper.needsSignIn)")

        // 7. Campus's own login page (waits for a click) is the same: needs a sign-in.
        await arm("page")
        let onLogin = await until(25) { keeper.needsSignIn }
        report("Campus refresh: Campus's own login page, which waits for a click, also means sign in again (nothing is clicked)", onLogin && keeper.lastAttempt?.outcome == .needsSignIn, "outcome=\(keeper.lastAttempt?.outcome.rawValue ?? "nil")")

        // 8. An answer that never comes: time out, view dropped, and no 'sign in again' (nothing said the person is needed).
        await signIn(life: 3600)
        keeper.attemptTimeout = 2
        await arm("hang")
        _ = await until(10) { renewal.isAttempting }
        let hiddenWindow = renewal.hiddenViewHasWindow
        let timedOut = await until(15) { keeper.lastAttempt?.outcome == .timeout }
        report("Campus refresh: an answer that never comes ends at the time limit, the hidden view never sat in a window, and it does not say sign in again",
               timedOut && hiddenWindow == false && !keeper.needsSignIn && !renewal.isAttempting && renewal.hiddenViewHasWindow == nil, "outcome=\(keeper.lastAttempt?.outcome.rawValue ?? "nil") hadWindow=\(hiddenWindow.map { "\($0)" } ?? "nil")")

        // 9. Put everything back.
        await signIn(life: 3600)
        keeper.attemptTimeout = 25
        renewal.settleDelay = 2.5
        report("Campus refresh: after all of it the link is live with the usual rows and the stand-in is back to its login page (the rows include the threads the bridge checks started)", campus.link == .live && campus.conversations.count >= 8 && !keeper.needsSignIn, "link=\(campus.link) rows=\(campus.conversations.count)")
    }
}
