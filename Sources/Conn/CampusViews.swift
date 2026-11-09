// Campus in the window, part one: the CAMPUS sidebar section, the status bar item and the sign-in sheet.
// Decisions (README "Campus in Conn"): C1 its own section; C2 Campus asks count with Herdr's; C3 Conn's four state glyphs; C4 team spaces fold under one line that
// still shows asks and working counts; C9 when the login expires the last rows stay, dimmed, with "as of" and a sign-in note on top.
import SwiftUI
import WebKit
import ConnCore

/// What a Campus row says under its title.
enum CampusWords {
    static func state(_ c: CampusConversation, link: CampusLink, asOf: Date?) -> String {
        if link == .expired { return "as of \(asOf.map(CampusTime.clock) ?? "earlier")" }
        return c.state.label
    }
    static func sub(_ c: CampusConversation, link: CampusLink, asOf: Date?) -> String {
        "campus" + (c.isTeam ? " · \(c.spaceName)" : "") + " · " + state(c, link: link, asOf: asOf)
    }
    static func openAsk(_ c: CampusConversation) -> OpenAsk? {
        guard let a = c.ask else { return nil }
        return OpenAsk(paneID: "campus", session: c.id, message: nil, lines: [a.text], at: a.at ?? c.updatedAt, tags: [a.tag])
    }
}

struct CampusSection: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    @State private var teamsOpen = false
    /// The rows' own height: the section is as tall as its rows (up to its cap), not as tall as the room it is offered, so Herdr's agents keep the room.
    @State private var contentHeight: CGFloat = 40
    static let maxHeight: CGFloat = 230

    var body: some View {
        let expired = campus.link == .expired
        let blocked = campus.link == .blocked
        return VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 1) {
                    switch campus.link {
                    case .starting where campus.conversations.isEmpty: starting
                    default:
                        if expired { expiredNote }
                        if blocked { CampusBlockedNote(onTryAgain: { app.retryCampus() }, id: "campus-blocked-note", button: "campus-tryagain") }
                        // The silent refresh could not finish on its own: the session still works, but only a sign-in will keep it going.
                        if !expired, campus.link == .live, let keeper = app.campusKeeper { CampusRenewNote(keeper: keeper) }
                        if case .unreachable(let why) = campus.link { note(title: "Campus is not reachable", text: why, error: true, signIn: true) }
                        if !((expired || blocked) && campus.conversations.isEmpty) { content(dim: expired) }
                    }
                }
                .padding(.horizontal, 6).padding(.bottom, 6)
                .background(GeometryReader { g in Color.clear.preference(key: CampusContentHeight.self, value: g.size.height) })
            }
            .onPreferenceChange(CampusContentHeight.self) { contentHeight = $0 }
        }
        .frame(height: min(Self.maxHeight, contentHeight + 36))
        .accessibilityIdentifier("campus-section")
    }

    // MARK: header

    private var header: some View {
        HStack(spacing: 4) {
            Text("CAMPUS").font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary)
            Spacer()
            switch campus.link {
            case .starting: ProgressView().controlSize(.mini); Text("starting…").font(.system(size: 11)).foregroundStyle(.tertiary)
            case .expired: Text("signed out").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color)
            case .unreachable: Text("offline").font(.system(size: 11)).foregroundStyle(.tertiary)
            case .blocked: Text("blocked").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color)
            default:
                let asks = campus.asks.count
                if asks > 0 { Text("\(asks) ask\(asks == 1 ? "" : "s")").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color); Text("·").font(.system(size: 11)).foregroundStyle(.tertiary) }
                Text("\(campus.workingCount) working").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
    }

    // MARK: body

    @ViewBuilder private func content(dim: Bool) -> some View {
        let mine = campus.privateRows
        subHeader("My space", trailing: "\(mine.count)", newIn: campus.spaces.first { !$0.isTeam })
        ForEach(mine) { c in CampusRow(campus: campus, c: c, dim: dim) }
        if mine.isEmpty && campus.link == .live { Text("No conversations yet").font(.system(size: 11)).foregroundStyle(.tertiary).padding(.horizontal, 10).padding(.vertical, 4) }
        let teams = campus.teamSpaces
        if !teams.isEmpty {
            Button { withAnimation(.easeInOut(duration: 0.12)) { teamsOpen.toggle() } } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right").font(.system(size: 8, weight: .bold)).rotationEffect(.degrees(teamsOpen ? 90 : 0)).frame(width: 9)
                    Text("Team spaces").font(.system(size: 11, weight: .semibold))
                    Spacer()
                    if !teamsOpen {
                        // C4: folded, the line still shows what needs you and what is running.
                        let asks = campus.asks(inTeam: true), working = campus.working(inTeam: true)
                        if asks > 0 { Text("\(asks) ask").foregroundStyle(AgentState.blocked.color) }
                        if working > 0 { Text("\(working) working").foregroundStyle(AgentState.working.color) }
                    }
                    Text("\(teams.count)").foregroundStyle(.tertiary)
                }
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 6).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityIdentifier("campus-teams").accessibilityValue(teamsOpen ? "open" : "folded")
            if teamsOpen {
                ForEach(teams) { s in
                    let rows = campus.rows(inSpace: s.id)
                    subHeader(s.displayName, trailing: "\(rows.count)", indent: true, newIn: s)
                    ForEach(rows) { c in CampusRow(campus: campus, c: c, dim: dim, indent: true) }
                }
            }
        }
    }

    /// `newIn`: the space this line starts a conversation in (a plus on the line); nil, read-only, or Campus not live: no plus.
    private func subHeader(_ title: String, trailing: String, indent: Bool = false, newIn space: CampusSpace? = nil) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
                .redacted(reason: app.privacy && indent ? .placeholder : [])
            Spacer()
            Text(trailing).font(.system(size: 11)).foregroundStyle(.tertiary)
            if let space = space, !space.readOnly, campus.link == .live {
                Button { app.newCampusConversation(in: space) } label: { Image(systemName: "plus").font(.system(size: 10, weight: .semibold)).frame(width: 18, height: 16).contentShape(Rectangle()) }
                    .buttonStyle(.plain).foregroundStyle(campus.writesEnabled ? Color.secondary : Color.secondary.opacity(0.4))
                    .help(campus.writesEnabled ? "New conversation in \(space.displayName)" : "New conversation: Campus writes are off")
                    .accessibilityLabel("New conversation in \(space.displayName)").accessibilityIdentifier("campus-new-\(space.id)")
            }
        }
        .padding(.horizontal, 10).padding(.leading, indent ? 8 : 0).padding(.top, 6).padding(.bottom, 2)
    }

    private var starting: some View {
        VStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.07)).frame(height: 30).padding(.horizontal, 8) }
            note(title: "Campus is starting your workspace", text: "The first start takes up to a minute. Conn asks again every 5 seconds and fills this list when Campus answers.", error: false)
        }
        .padding(.top, 6)
        .accessibilityIdentifier("campus-starting")
    }

    /// Never signed in: one line and a button, so the section takes little room until there is something to list.
    private var signInLine: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(.tertiary)
            Text("Not signed in to Campus").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 4)
            Button("Sign in") { app.signInToCampus() }.controlSize(.small).accessibilityIdentifier("campus-signin")
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .accessibilityIdentifier("campus-signin-line")
    }

    @ViewBuilder private var expiredNote: some View {
        if campus.asOf == nil { signInLine } else { expiredCard }
    }

    private var expiredCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(campus.asOf == nil ? "Sign in to Campus" : "Campus sign-in expired").font(.system(size: 12, weight: .semibold))
            Text(campus.asOf == nil
                 ? "Sign in once and Conn lists your Campus conversations here. The sign-in stays in Conn's own web view and nothing is copied out of it."
                 : "Conn can no longer read your conversations. Sign in again: the sign-in stays in Conn's own web view and nothing is copied out of it. The list below is what Conn last saw, at \(app.campusTimeText ?? "an earlier time").")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Sign in to Campus") { app.signInToCampus() }.controlSize(.small).accessibilityIdentifier("campus-signin")
                Button("Open in web") { NSWorkspace.shared.open(campus.baseURL) }.controlSize(.small)
            }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(AgentState.blocked.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(AgentState.blocked.color.opacity(0.35)))
        .padding(.horizontal, 4).padding(.vertical, 4)
        .accessibilityIdentifier("campus-expired-note")
    }

    /// `signIn`: the note also offers the sign-in, because a Campus that cannot be read may only need one (and the person has no other button here).
    private func note(title: String, text: String, error: Bool, signIn: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 12, weight: .semibold))
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if signIn { Button("Sign in to Campus") { app.signInToCampus() }.controlSize(.small).padding(.top, 2).accessibilityIdentifier("campus-signin-unreachable") }
        }
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background((error ? AgentState.blocked.color : Color.primary).opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .padding(.horizontal, 4)
    }
}

/// "Campus refused the connection": the network answered, not Campus (nginx's 403 page, off the company private network). Says so, says what to check, and offers
/// Try again (never Sign in: the sign-in is not the problem). Used in the sidebar and, bigger, over the sign-in sheet's web view.
struct CampusBlockedNote: View {
    let onTryAgain: () -> Void
    let id: String
    let button: String
    var roomy = false

    var body: some View {
        VStack(alignment: .leading, spacing: roomy ? 10 : 6) {
            HStack(spacing: 6) {
                Image(systemName: "network.slash").font(.system(size: roomy ? 15 : 11, weight: .semibold)).foregroundStyle(AgentState.blocked.color)
                Text(CampusNetworkBlock.title).font(.system(size: roomy ? 14 : 12, weight: .semibold))
            }
            Text(CampusNetworkBlock.note).font(.system(size: roomy ? 12.5 : 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button("Try again", action: onTryAgain).controlSize(roomy ? .regular : .small).accessibilityIdentifier(button)
        }
        .padding(roomy ? 16 : 10).frame(maxWidth: roomy ? 420 : .infinity, alignment: .leading)
        .background(AgentState.blocked.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(AgentState.blocked.color.opacity(0.35)))
        .padding(.horizontal, roomy ? 0 : 4).padding(.vertical, roomy ? 0 : 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

/// "Campus: sign in again": the hidden attempt to renew the session ran into a page that needs the person (Google waiting for a click or an account, Campus's own
/// login page), so Conn stopped. The session still works until it ends; the normal Sign in action is the way on.
struct CampusRenewNote: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var keeper: CampusSessionKeeper

    var body: some View {
        if keeper.needsSignIn {
            VStack(alignment: .leading, spacing: 6) {
                Text("Campus: sign in again").font(.system(size: 12, weight: .semibold))
                Text("Conn could not renew your Campus sign-in on its own\(keeper.expiry.map { ", so it ends at \(CampusTime.clock($0))" } ?? ""). Sign in again to keep your conversations live. The sign-in stays in Conn's own web view and nothing is copied out of it.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Sign in to Campus") { app.signInToCampus() }.controlSize(.small).accessibilityIdentifier("campus-renew-signin")
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(AgentState.blocked.color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(AgentState.blocked.color.opacity(0.35)))
            .padding(.horizontal, 4).padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("campus-renew-note")
        }
    }
}

/// Settings: when the session ends and what the last silent refresh came to.
struct CampusSessionSettingsSection: View {
    @ObservedObject var keeper: CampusSessionKeeper

    static func lastText(_ a: CampusRenewalAttempt?) -> String {
        guard let a = a else { return "No silent refresh yet. Conn tries about 5 minutes before the session ends." }
        var s = "\(CampusTime.stamp(a.at)): \(a.outcome.label)"
        if a.outcome == .renewed, let n = a.newExpiry { s += ", the session now ends at \(CampusTime.stamp(n))" }
        if a.outcome == .needsSignIn { s += ", sign in again" }
        return s
    }

    var body: some View {
        Section("Campus session") {
            HStack {
                Text("Session ends")
                Spacer()
                Text(keeper.expiry.map { CampusTime.stamp($0) } ?? "no session in Conn's web view").foregroundStyle(.secondary).accessibilityIdentifier("campus-session-ends")
            }
            HStack(alignment: .firstTextBaseline) {
                Text("Last silent refresh")
                Spacer()
                Text(keeper.attempting ? "trying now…" : Self.lastText(keeper.lastAttempt)).foregroundStyle(.secondary).multilineTextAlignment(.trailing).accessibilityIdentifier("campus-session-last")
            }
            Text("About 5 minutes before the session ends Conn opens Campus's own sign-in in a hidden web view that shares its sign-in. If Google and Campus finish it without asking you anything, the session carries on. If any page needs a click, an account or a password, Conn stops there and the CAMPUS section says to sign in again. Conn never clicks, types or answers anything in that view, and never writes the sign-in token anywhere: the log (Application Support, Conn, campus, session-refresh.log) holds times and outcomes only.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Settings: when the network last refused Campus. Campus answers only on the company private network; the log (Application Support, Conn, campus, sign-in-hops.log) holds the
/// sign-in sheet's hops as time, host, path and status, never a query, a cookie or a token.
struct CampusConnectionSettingsSection: View {
    @ObservedObject var campus: CampusStore
    let hops: CampusHopLog?
    @State private var logged: Date?

    static func blockedText(link: CampusLink, thisRun: Date?, logged: Date?) -> String {
        if link == .blocked { return "now" + (thisRun.map { " (since \(CampusTime.stamp($0)))" } ?? "") }
        guard let last = [thisRun, logged].compactMap({ $0 }).max() else { return "never" }
        return CampusTime.stamp(last)
    }

    var body: some View {
        Section("Campus connection") {
            HStack {
                Text("Last blocked by the network")
                Spacer()
                Text(Self.blockedText(link: campus.link, thisRun: campus.lastBlockedAt, logged: logged)).foregroundStyle(.secondary).accessibilityIdentifier("campus-last-blocked")
            }
            Text("Campus answers only on the company private network (Zscaler private access). Off it, a public address answers every request with an nginx \"403 Forbidden\" page. Conn calls that blocked, not signed out: the CAMPUS section and the sign-in sheet say to check Zscaler and offer Try again. Each hop of the sign-in sheet is logged (Application Support, Conn, campus, sign-in-hops.log) as time, host, path and status only.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .onAppear { reload() }
        .onChange(of: campus.link) { _, _ in reload() }
    }

    private func reload() { logged = campus.baseURL.host.flatMap { hops?.lastBlocked(campusHost: $0) } }
}

private struct CampusContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct CampusRow: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let c: CampusConversation
    var dim = false
    var indent = false

    var body: some View {
        let live = campus.link == .live
        let starred = app.campusIsStarred(c.id)
        SidebarRow(selected: app.campusSelectedID == c.id, action: { app.openCampus(c.id) }) {
            HStack(alignment: .top, spacing: 8) {
                StateGlyph(state: c.state)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(c.title).font(.system(size: 13, weight: .medium)).lineLimit(2).truncationMode(.tail)
                            .redacted(reason: app.privacy ? .placeholder : [])
                            .help(app.privacy ? "Campus conversation" : c.title)
                        if app.campusBridge?.ownership.mode(of: c.id) != nil { Image(systemName: "cpu").font(.system(size: 8.5)).foregroundStyle(.secondary).help("Agents may use this thread (agent bridge)").accessibilityIdentifier("campus-row-shared") }
                        if starred { Image(systemName: "star.fill").font(.system(size: 8.5)).foregroundStyle(.secondary).accessibilityIdentifier("campus-row-star") }
                    }
                    Text(CampusWords.sub(c, link: campus.link, asOf: campus.asOf)).font(.system(size: 11))
                        .foregroundStyle(live && c.state.waitsOnCaptain ? c.state.color : Color.secondary).lineLimit(1)
                    if live, c.needsYou, let ask = CampusWords.openAsk(c) { AskBlock(ask: ask, privacy: app.privacy) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .contextMenu {
            Button(starred ? "Remove Star" : "Star in the Reader Row") { app.toggleCampusStar(c) }
            Button("Open in a Watch Column") { app.showCampusInWatch(c.id) }
            BridgeShareMenu(c: c)
            Divider()
            Button("Open in Campus (Web)") { if let u = campus.webURL(for: c) { NSWorkspace.shared.open(u) } }
        }
        .padding(.leading, indent ? 8 : 0)
        .opacity(dim ? 0.55 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("campus-row")
        .accessibilityLabel(app.privacy ? "Campus conversation" : c.title)
        .accessibilityValue(c.state.label)
    }
}

// MARK: - Status bar

/// "Campus · signed in" in the status bar: a dot for the link and, when signed out, a click that opens the sign-in.
struct CampusStatusItem: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        if app.campus.link != .disabled { CampusStatusInner(campus: app.campus) }
    }
}

private struct CampusStatusInner: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore

    var body: some View {
        HStack(spacing: 10) {
            Text("·").foregroundStyle(.tertiary)
            Button { if campus.link == .expired { app.signInToCampus() } } label: {
                HStack(spacing: 5) {
                    Circle().fill(color).frame(width: 7, height: 7)
                    Text(text)
                }
            }
            .buttonStyle(.plain).help(campus.link == .expired ? "Sign in to Campus" : campus.link == .blocked ? CampusNetworkBlock.note : "Campus link")
            .accessibilityIdentifier("campus-status")
            if campus.link == .live {
                Button { if campus.writesEnabled { app.disableCampusWrites() } else { app.requestCampusWrites() } } label: {
                    Text(campus.writesEnabled ? "Campus: sending on" : "Campus: observe only")
                        .foregroundStyle(campus.writesEnabled ? Color.orange : Color.secondary)
                }
                .buttonStyle(.plain).help("Campus writes: sending, steering, answers, Stop and the model and agent pickers need this on")
                .accessibilityIdentifier("campus-writes-switch")
            }
            BridgeStatusItem()
        }
    }

    private var color: Color {
        switch campus.link {
        case .live: return AgentState.done.color
        case .starting: return .yellow
        case .expired, .blocked: return AgentState.blocked.color
        default: return .gray
        }
    }

    private var text: String {
        switch campus.link {
        case .live: return "Campus · signed in"
        case .starting: return "Campus · starting…"
        case .expired: return "Campus · signed out"
        case .unreachable: return "Campus · offline"
        case .blocked: return "Campus · blocked by the network"
        case .disabled: return ""
        }
    }
}

// MARK: - Sign-in sheet

/// Conn's own web view on Campus's login page. The sign-in stays in the web view; when Campus answers again the sheet closes by itself.
struct CampusSignInSheet: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "lock.fill").foregroundStyle(.secondary)
                Text("Sign in to Campus").font(.system(size: 13, weight: .semibold))
                Spacer()
                if campus.link == .live { Label("Signed in", systemImage: "checkmark.circle.fill").foregroundStyle(AgentState.done.color).font(.system(size: 12)) }
            }
            .padding(.horizontal, 14).frame(height: 40)
            Divider()
            if let auth = app.campusAuth { CampusSignInBody(auth: auth) }
            Divider()
            HStack {
                Text("Conn never sees your password. The sign-in cookie stays inside this web view.").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button(campus.link == .live ? "Done" : "Cancel") { app.closeCampusSignIn() }.keyboardShortcut(.cancelAction).accessibilityIdentifier("campus-signin-close")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .task {
            // Look again every 2 seconds, so the sheet notices the sign-in the moment it is done.
            while !Task.isCancelled {
                campus.kick()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if campus.link == .live { try? await Task.sleep(nanoseconds: 800_000_000); app.closeCampusSignIn(); return }
            }
        }
    }
}

/// The sheet's page: Conn's web view on Campus's login, or, when the network refused Campus's host, the same message the sidebar shows with a Try again, in place of nginx's raw page.
private struct CampusSignInBody: View {
    @ObservedObject var auth: CampusWebAuth

    var body: some View {
        ZStack {
            CampusSignInWeb(web: auth.signInView)
            if auth.signInRefused {
                CampusBlockedSheetCard(onTryAgain: { auth.retrySignIn() })
            }
        }
        .frame(minWidth: 520, minHeight: 560)
    }
}

/// What the sheet shows over its web view when the network refused Campus's host: the same card on the window's own background. Shared by the sheet and the check's picture.
struct CampusBlockedSheetCard: View {
    let onTryAgain: () -> Void
    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            CampusBlockedNote(onTryAgain: onTryAgain, id: "campus-blocked-sheet", button: "campus-signin-tryagain", roomy: true).padding(24)
        }
    }
}

/// Settings (Conn > Settings, Cmd+,): the "Campus writes" switch, the second place it lives beside the status bar.
struct CampusSettingsView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore

    var body: some View {
        Form {
            Section("Campus") {
                Toggle("Campus writes", isOn: Binding(get: { campus.writesEnabled }, set: { on in if on { app.requestCampusWrites() } else { app.disableCampusWrites() } }))
                    .disabled(campus.link == .disabled)
                Text("Off by default and off again at every launch. On, Conn can send a message, answer a question, stop a run and change the model or agent in a Campus conversation. Every write waits 3 seconds with an Undo. Conn reads Campus either way.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if campus.link == .disabled { Text("Campus is not part of this launch.").font(.system(size: 11)).foregroundStyle(.secondary) }
            }
            CampusConnectionSettingsSection(campus: campus, hops: app.campusHops)
            if let k = app.campusKeeper { CampusSessionSettingsSection(keeper: k) }
            if let b = app.campusBridge { BridgeSettingsSection(bridge: b) }
            Section("Starred conversations") {
                HStack {
                    Text(app.campusStars.entries.isEmpty ? "None starred" : "\(app.campusStars.entries.count) starred in the Reader column's row")
                    Spacer()
                    Button("Remove All Stars") { app.campusStars.clear() }.disabled(app.campusStars.entries.isEmpty).accessibilityIdentifier("campus-stars-clear")
                }
                Text("Conn keeps only where each one is (its space and id) and their order, in its own settings. No title or text is written to disk.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .formStyle(.grouped).frame(width: 520, height: 760)
    }
}
