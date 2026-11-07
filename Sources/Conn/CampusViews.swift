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
        return VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 1) {
                    switch campus.link {
                    case .starting where campus.conversations.isEmpty: starting
                    default:
                        if expired { expiredNote }
                        if case .unreachable(let why) = campus.link { note(title: "Campus is not reachable", text: why, error: true, signIn: true) }
                        if !(expired && campus.conversations.isEmpty) { content(dim: expired) }
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
        subHeader("My space", trailing: "\(mine.count)")
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
                    subHeader(s.displayName, trailing: "\(rows.count)", indent: true)
                    ForEach(rows) { c in CampusRow(campus: campus, c: c, dim: dim, indent: true) }
                }
            }
        }
    }

    private func subHeader(_ title: String, trailing: String, indent: Bool = false) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
                .redacted(reason: app.privacy && indent ? .placeholder : [])
            Spacer()
            Text(trailing).font(.system(size: 11)).foregroundStyle(.tertiary)
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
        SidebarRow(selected: app.campusSelectedID == c.id, action: { app.openCampus(c.id) }) {
            HStack(alignment: .top, spacing: 8) {
                StateGlyph(state: c.state)
                VStack(alignment: .leading, spacing: 1) {
                    Text(c.title).font(.system(size: 13, weight: .medium)).lineLimit(2).truncationMode(.tail)
                        .redacted(reason: app.privacy ? .placeholder : [])
                        .help(app.privacy ? "Campus conversation" : c.title)
                    Text(CampusWords.sub(c, link: campus.link, asOf: campus.asOf)).font(.system(size: 11))
                        .foregroundStyle(live && c.state.waitsOnCaptain ? c.state.color : Color.secondary).lineLimit(1)
                    if live, c.needsYou, let ask = CampusWords.openAsk(c) { AskBlock(ask: ask, privacy: app.privacy) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
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
            .buttonStyle(.plain).help(campus.link == .expired ? "Sign in to Campus" : "Campus link")
            .accessibilityIdentifier("campus-status")
            if campus.link == .live {
                Button { if campus.writesEnabled { app.disableCampusWrites() } else { app.requestCampusWrites() } } label: {
                    Text(campus.writesEnabled ? "Campus: sending on" : "Campus: observe only")
                        .foregroundStyle(campus.writesEnabled ? Color.orange : Color.secondary)
                }
                .buttonStyle(.plain).help("Campus writes: sending, steering, answers, Stop and the model and agent pickers need this on")
                .accessibilityIdentifier("campus-writes-switch")
            }
        }
    }

    private var color: Color {
        switch campus.link {
        case .live: return AgentState.done.color
        case .starting: return .yellow
        case .expired: return AgentState.blocked.color
        default: return .gray
        }
    }

    private var text: String {
        switch campus.link {
        case .live: return "Campus · signed in"
        case .starting: return "Campus · starting…"
        case .expired: return "Campus · signed out"
        case .unreachable: return "Campus · offline"
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
            if let auth = app.campusAuth { CampusSignInWeb(web: auth.signInView).frame(minWidth: 520, minHeight: 560) }
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
        }
        .formStyle(.grouped).frame(width: 460, height: 230)
    }
}
