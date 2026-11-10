// Campus in the window, part two: the centre "live view" (steps, tools with their time, folded reasoning, the question as a card) and the reader-style
// transcript (replies, a "N tool steps" line, "Waiting on you") that the Reader column and a Watch column (C5) show, with a live strip while it runs.
// Both read one `CampusStore` timeline; a redraw is one conversation's, never the window's.
import SwiftUI
import Combine
import ConnCore

/// Keeps a conversation's timeline alive while a view shows it, and redraws that view when it changes (a burst of text deltas is one redraw per 60 ms).
private struct TimelineSubscription: ViewModifier {
    let campus: CampusStore
    let id: String
    @Binding var tick: Int

    func body(content: Content) -> some View {
        content
            .onAppear { campus.retain(id) }
            .onDisappear { campus.release(id) }
            .onReceive(campus.timelineChanged.filter { $0 == id }.throttle(for: .milliseconds(60), scheduler: RunLoop.main, latest: true)) { _ in tick += 1 }
    }
}

/// Text that may name another Campus conversation by its link: a click opens it by the Watch column rule, Cmd-click in the normal view (C6).
struct CampusText: View {
    @EnvironmentObject var app: AppModel
    let text: String
    var font: Font = .system(size: 13)
    var column: Int?

    var body: some View {
        Text(Self.attributed(text)).font(font).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            .redacted(reason: app.privacy ? .placeholder : [])
            .environment(\.openURL, OpenURLAction { url in
                if let host = app.campus.baseURL.host, let ref = CampusClient.conversationLink(url, campusHost: host) {
                    app.openCampusLink(kind: ref.kind, folder: ref.folder, id: ref.id, command: NSEvent.modifierFlags.contains(.command), fromColumn: column)
                    return .handled
                }
                return url.scheme == "https" || url.scheme == "http" ? .systemAction : .discarded
            })
    }

    static func attributed(_ s: String) -> AttributedString {
        var a = AttributedString(s)
        guard let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return a }
        for m in det.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            guard let url = m.url, let r = Range(m.range, in: s), let lo = AttributedString.Index(r.lowerBound, within: a), let hi = AttributedString.Index(r.upperBound, within: a) else { continue }
            a[lo..<hi].link = url
        }
        return a
    }
}

private struct OptionChip: View {
    let label: String
    var on = false
    var body: some View {
        Text(label).font(.system(size: 12)).padding(.horizontal, 10).padding(.vertical, 4)
            .background(on ? AgentState.working.color.opacity(0.18) : Color.primary.opacity(0.06), in: Capsule())
            .overlay(Capsule().stroke(on ? AgentState.working.color : Color.primary.opacity(0.14)))
    }
}

/// The question card, read-only here: the questions and their options, and a way to answer in Campus's own page.
private struct FormCard: View {
    @EnvironmentObject var app: AppModel
    let form: CampusForm
    let c: CampusConversation
    var title = "Campus asks you"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(AgentState.blocked.color); Spacer() }
            if case .answered(let t) = form.status {
                ForEach(Array(form.questions.enumerated()), id: \.offset) { _, q in Text(q.text).font(.system(size: 13, weight: .semibold)) }
                Text("Answered: \(t)").font(.system(size: 12)).foregroundStyle(AgentState.done.color)
            } else {
                ForEach(Array(form.questions.enumerated()), id: \.offset) { qi, q in
                    Text(q.text).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    FlowLayout(spacing: 6, rowSpacing: 6) { ForEach(q.options, id: \.self) { CampusOptionButton(campus: app.campus, form: form, c: c, question: qi, option: $0) } }
                }
                CampusAnswerControls(campus: app.campus, form: form, c: c)
            }
        }
        .redacted(reason: app.privacy ? .placeholder : [])
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(AgentState.blocked.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(AgentState.blocked.color).frame(width: 2) }
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityElement(children: .contain).accessibilityIdentifier("campus-form-card")
    }
}

/// The answer buttons of an open question (slice 2): picking an option on a single question sends it (through the write gate); several questions pick first and then
/// "Send answers". "Answer in web" is Campus's own page, as before.
struct CampusAnswerControls: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let form: CampusForm
    let c: CampusConversation

    var body: some View {
        let ready = campus.pickedAnswers(form) != nil
        HStack(spacing: 8) {
            if form.questions.count > 1 {
                Button("Send answers") { app.campusAnswer(form, in: c) }.controlSize(.small).disabled(!ready).accessibilityIdentifier("campus-send-answers")
                Text(ready ? "Ready." : "Pick one for each question.").font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                Text(campus.writesEnabled ? "Click an answer to send it." : "Campus writes are off: turn them on to answer here.").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button("Answer in web") { if let u = campus.webURL(for: c) { NSWorkspace.shared.open(u) } }.controlSize(.small)
        }
    }
}

/// One option of an open question: a button that picks it (and, for a single question, sends it).
struct CampusOptionButton: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let form: CampusForm
    let c: CampusConversation
    let question: Int
    let option: String

    var body: some View {
        let on = campus.picks[form.id]?[question] == option
        Button { app.campusPick(form, in: c, question: question, option: option) } label: { OptionChip(label: option, on: on) }
            .buttonStyle(.plain).accessibilityIdentifier("campus-option")
    }
}

private struct ExpiredBanner: View {
    @EnvironmentObject var app: AppModel
    var body: some View {
        HStack(spacing: 8) {
            StateGlyph(state: .blocked, size: 13)
            Text("Signed out of Campus. Showing what Conn last saw, at \(app.campusTimeText ?? "an earlier time").").font(.system(size: 12))
            Spacer()
            Button("Sign in to Campus") { app.signInToCampus() }.controlSize(.small).accessibilityIdentifier("campus-banner-signin")
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(AgentState.blocked.color.opacity(0.12))
        .accessibilityIdentifier("campus-expired-banner")
    }
}

private struct StartingBox: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Campus is starting").font(.system(size: 14, weight: .semibold))
            Text("Your workspace is booting. This view reconnects by itself and reads the last 50 messages, so nothing is lost.").font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 320)
        }
        .padding(30).frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("campus-starting-box")
    }
}

// MARK: - the live view (centre)

struct CampusLiveView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let id: String
    @State private var tick = 0
    @State private var openReasoning: Set<String> = []

    var body: some View {
        let _ = tick
        Group {
            if let c = campus.conversation(id) {
                let timeline = campus.timeline(id) ?? CampusTimeline()
                VStack(spacing: 0) {
                    header(c, timeline)
                    Divider()
                    if campus.link == .expired { ExpiredBanner() }
                    if campus.link == .starting && !timeline.loaded { StartingBox() } else { log(c, timeline) }
                    Divider()
                    CampusComposer(campus: campus, c: c, compact: false)
                }
                .accessibilityIdentifier("campus-live-view")
            } else {
                VStack(spacing: 6) { Text("That Campus conversation is not in the list").font(.system(size: 13, weight: .semibold)); Text("It may have been deleted, or Campus has not listed it yet.").font(.system(size: 12)).foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .modifier(TimelineSubscription(campus: campus, id: id, tick: $tick))
        .id(id)
    }

    private func header(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        HStack(spacing: 8) {
            StateGlyph(state: c.state, size: 13)
            Text(c.title).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail).redacted(reason: app.privacy ? .placeholder : [])
            if c.isTeam { pill("team space · \(c.spaceName)", tint: AgentState.working.color) } else { Text(c.spaceName.isEmpty ? "My space" : c.spaceName).font(.system(size: 11)).foregroundStyle(.secondary) }
            Spacer(minLength: 8)
            if let tokens = t.lastTokens { Text(tokens).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary) }
            if let m = c.model { pill(m) }
            if let a = c.agent { pill(a) }
            if campus.link == .live { pill("live", tint: AgentState.done.color) }
            CampusStarButton(c: c)
            CampusStopButton(campus: campus, c: c)
        }
        .padding(.horizontal, 14).frame(height: 36)
        .accessibilityIdentifier("campus-live-header")
    }

    private func pill(_ s: String, tint: Color = .secondary) -> some View {
        Text(s).font(.system(size: 10.5, weight: .medium)).foregroundStyle(tint).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2).background(tint.opacity(0.12), in: Capsule())
    }

    private func log(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        let form = campus.openForms[id]
        let shownIDs = Set(t.items.compactMap { $0.form?.id })
        return GeometryReader { g in ScrollView {
            LazyVStack(alignment: .leading, spacing: 7) {
                ForEach(t.items) { row($0, c) }
                if let f = form, !shownIDs.contains(f.id), c.needsYou { gutter("", FormCard(form: f, c: c)) }
                if c.working && !t.items.contains(where: { $0.streaming }) { gutter("", Text("▍").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)) }
                Color.clear.frame(height: 1).id("bottom")
            }
            .padding(14).frame(maxWidth: .infinity, minHeight: g.size.height, alignment: .topLeading)
        }
        .defaultScrollAnchor(.bottom) }
        .background(Color(nsColor: .textBackgroundColor))
        .opacity(campus.link == .expired ? 0.6 : 1)
        .accessibilityIdentifier("campus-log")
    }

    private func gutter<V: View>(_ label: String, _ content: V) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary).frame(width: 52, alignment: .trailing)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func row(_ i: CampusItem, _ c: CampusConversation) -> some View {
        switch i.kind {
        case .user: gutter("you", CampusText(text: i.text, font: .system(size: 13, weight: .medium)))
        case .step: gutter("step \(i.step)", Text(i.detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary))
        case .reasoning:
            gutter("", VStack(alignment: .leading, spacing: 3) {
                Button { if openReasoning.contains(i.id) { openReasoning.remove(i.id) } else { openReasoning.insert(i.id) } } label: {
                    Text("\(openReasoning.contains(i.id) ? "▾" : "▸") thinking\(i.streaming ? "…" : "")").font(.system(size: 11)).foregroundStyle(.secondary)
                }.buttonStyle(.plain)
                if openReasoning.contains(i.id) { Text(i.text).font(.system(size: 12)).italic().foregroundStyle(.secondary).redacted(reason: app.privacy ? .placeholder : []) }
            })
        case .tool: gutter("⚙", CampusToolCard(item: i, privacy: app.privacy))
        case .text: gutter("", CampusText(text: i.text + (i.streaming ? " ▍" : "")))
        case .form: if let f = i.form { gutter("", FormCard(form: f, c: c)) }
        case .stopped: gutter("■", Text("Stopped by you · interrupt sent").font(.system(size: 12)).foregroundStyle(AgentState.blocked.color))
        case .idle: gutter("●", Text("done\(i.detail.isEmpty ? "" : " · " + i.detail)").font(.system(size: 12)).foregroundStyle(AgentState.done.color))
        }
    }
}

// MARK: - the transcript (Reader column, Watch column)

struct CampusTranscriptView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let id: String
    /// The Watch column this is drawn in (a link clicked here goes by the column rule), or nil in the Reader column.
    var column: Int?
    /// The column's content is hidden (Watch focus): blurred, and no click or key reaches it.
    var hidden = false
    /// Counts the times the column was asked to land on the newest reply (a finished turn's cue was shown): the transcript scrolls to it.
    var landTick = 0
    @State private var tick = 0
    @State private var openTools: Set<String> = []
    /// The reader's embed page this conversation is drawn on, once it has loaded (E9=a); until then, or without it, the native `page` below.
    @StateObject private var embed = CampusEmbedBox()

    var body: some View {
        // The outer Group keeps its identity when the conversation changes (the page stays loaded and is handed the other conversation); the inner one does not.
        Group { conversation }
            .blur(radius: hidden ? 9 : 0)
            .allowsHitTesting(!hidden)
            .onAppear { embed.start(url: app.web.embedURL); embed.setContentHidden(hidden) }
            .onDisappear { embed.release() }
            .onChange(of: id) { _, _ in embed.retryIfUnavailable(url: app.web.embedURL) }
            .onChange(of: hidden) { _, now in embed.setContentHidden(now) }
            .onChange(of: landTick) { _, _ in Task { await embed.landOnLastReply() } }
    }

    private var conversation: some View {
        let _ = tick
        return Group {
            if let c = campus.conversation(id) {
                let t = campus.timeline(id) ?? CampusTimeline()
                VStack(spacing: 0) {
                    // A hidden column (Watch focus) shows nothing but its blurred transcript: the column's own header already names the conversation and its state.
                    if !hidden { head(c, t); Divider() }
                    if campus.link == .expired && !hidden { ExpiredBanner() }
                    if campus.link == .starting && !t.loaded { StartingBox() } else { transcript(c, t) }
                    if !hidden { CampusComposer(campus: campus, c: c, compact: true, pageBar: embed.composerOn && embed.phase == .ready && !app.privacy) }
                }
                .accessibilityIdentifier("campus-transcript")
            } else {
                Text("That Campus conversation is not in the list").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .modifier(TimelineSubscription(campus: campus, id: id, tick: $tick))
        .id(id)
    }

    /// The transcript: the reader's own page when it is loaded (and the screen is not in privacy mode, which the native view redacts), else the native one.
    /// An open question stays native either way: the page draws questions but cannot answer one, so the buttons sit under it.
    private func transcript(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        let ready = embed.phase == .ready && !app.privacy
        var offered = true
        if case .unavailable = embed.phase { offered = false }
        let json = offered && !app.privacy ? CampusEmbed.json(id: id, timeline: t, working: c.working) : nil
        let asking = t.openForm ?? (c.needsYou ? campus.openForms[id] : nil)
        // The page's own message bar (select-to-ask, comments, the batch, Send, Undo, Now), when the page has one: Send is on while Campus writes are on and the link is live.
        let reason = CampusEmbed.sendReason(writesEnabled: campus.writesEnabled, link: campus.link)
        let composer = ready ? CampusEmbed.composerConfig(name: c.title, send: reason == nil, reason: reason ?? "") : nil
        return VStack(spacing: 0) {
            ZStack {
                if !ready { if hidden { Color(nsColor: .textBackgroundColor) } else { page(c, t) } }
                CampusEmbedPane(box: embed, id: id, json: json, column: column, onLink: { url, command in openLink(url, command: command) },
                                composer: composer, onSend: { m in app.campusPageSend(m, shownID: id) { embed.answerSend(id: $0, error: $1) } })
                    .opacity(ready && (!embed.contentHidden || embed.hideApplied) ? 1 : 0).allowsHitTesting(ready && !hidden)
                    .opacity(campus.link == .expired ? 0.6 : 1)
                    .accessibilityIdentifier("campus-embed")
            }
            if ready, !hidden, let f = asking { waiting(f, c).padding(.horizontal, 12).padding(.vertical, 8) }
        }
    }

    /// A link the page handed to Conn: a Campus conversation opens by the column rule, any other web address in the browser.
    private func openLink(_ url: URL, command: Bool) {
        if let host = app.campus.baseURL.host, let ref = CampusClient.conversationLink(url, campusHost: host) {
            app.openCampusLink(kind: ref.kind, folder: ref.folder, id: ref.id, command: command, fromColumn: column)
        } else {
            CampusEmbedBox.openExternal(url)
        }
    }

    private func badge(_ c: CampusConversation) -> (String, Color) {
        switch campus.link {
        case .live: return ("live", AgentState.done.color)
        case .starting: return ("starting", .yellow)
        case .expired: return ("signed out", AgentState.blocked.color)
        case .blocked: return ("blocked", AgentState.blocked.color)
        default: return ("offline", .gray)
        }
    }

    private func head(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        let (word, tint) = badge(c)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(c.title).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail).redacted(reason: app.privacy ? .placeholder : [])
                Spacer(minLength: 4)
                CampusStarButton(c: c)
                Text(word).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(tint).padding(.horizontal, 7).padding(.vertical, 1.5).background(tint.opacity(0.14), in: Capsule())
            }
            HStack(spacing: 6) {
                Text(campus.link == .live ? "Live from Campus · in memory only" : campus.link == .starting ? "Waiting for Campus" : "Last seen \(app.campusTimeText ?? "earlier")")
                    .font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Spacer()
                Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t.plainText(), forType: .string); app.toast("Transcript copied") }
                    .controlSize(.mini).disabled(app.privacy)
                Button("Open in web") { if let u = campus.webURL(for: c) { NSWorkspace.shared.open(u) } }.controlSize(.mini)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func page(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        let blocks = t.blocks()
        let open = campus.openForms[id]
        let shown = Set(t.items.compactMap { $0.form?.id })
        return GeometryReader { g in ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(blocks) { b in block(b, c) }
                    if let f = open, !shown.contains(f.id), c.needsYou { waiting(f, c).id("ask") }
                    if c.working { liveStrip(t) }
                    Color.clear.frame(height: 1)
                }
                .padding(12).frame(maxWidth: .infinity, minHeight: g.size.height, alignment: .topLeading)
            }
            .defaultScrollAnchor(.bottom)
            .onAppear { if c.needsYou { DispatchQueue.main.async { proxy.scrollTo("ask", anchor: .center) } } }
            .onChange(of: landTick) { _, _ in
                if let last = blocks.last(where: { if case .reply = $0 { return true } else { return false } }) { withAnimation { proxy.scrollTo(last.id, anchor: .top) } }
            }
            .overlay(alignment: .topTrailing) {
                if c.needsYou && campus.link == .live {
                    Button("Needs you") { withAnimation { proxy.scrollTo("ask", anchor: .center) } }
                        .controlSize(.small).tint(AgentState.blocked.color).padding(8).accessibilityIdentifier("campus-needs-you")
                }
            }
        } }
        .background(Color(nsColor: .textBackgroundColor))
        .opacity(campus.link == .expired ? 0.6 : 1)
        .accessibilityIdentifier("campus-page")
    }

    @ViewBuilder private func block(_ b: CampusBlock, _ c: CampusConversation) -> some View {
        switch b {
        case .user(let i):
            HStack { Spacer(minLength: 30); CampusText(text: i.text, font: .system(size: 13), column: column).padding(.horizontal, 10).padding(.vertical, 7)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous)).fixedSize(horizontal: false, vertical: true) }
        case .reply(let rid, let tools, let texts, let form, let stopped):
            VStack(alignment: .leading, spacing: 6) {
                if !tools.isEmpty {
                    Button { if openTools.contains(rid) { openTools.remove(rid) } else { openTools.insert(rid) } } label: {
                        Text("\(tools.count) tool step\(tools.count == 1 ? "" : "s")").font(.system(size: 12)).foregroundStyle(.secondary).underline(true, pattern: .dot)
                    }.buttonStyle(.plain)
                    if openTools.contains(rid) {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(tools) { CampusToolCard(item: $0, privacy: app.privacy) }
                        }
                    }
                }
                ForEach(texts) { CampusText(text: $0.text, column: column) }
                if let f = form?.form {
                    if f.isOpen { waiting(f, c) } else { FormCard(form: f, c: c, title: "Campus asked") }
                }
                if stopped { Text("Stopped. You interrupted this run.").font(.system(size: 12)).foregroundStyle(AgentState.blocked.color) }
            }
            .padding(.leading, 10).padding(.vertical, 2)
            .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.18)).frame(width: 2) }
        }
    }

    private func waiting(_ f: CampusForm, _ c: CampusConversation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Waiting on you").font(.system(size: 12, weight: .semibold)).foregroundStyle(.orange)
            ForEach(Array(f.questions.enumerated()), id: \.offset) { qi, q in
                Text(q.text).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                FlowLayout(spacing: 6, rowSpacing: 6) { ForEach(q.options, id: \.self) { CampusOptionButton(campus: campus, form: f, c: c, question: qi, option: $0) } }
            }
            CampusAnswerControls(campus: campus, form: f, c: c)
        }
        .redacted(reason: app.privacy ? .placeholder : [])
        .padding(.leading, 10).padding(.vertical, 4)
        .overlay(alignment: .leading) { Rectangle().fill(Color.orange).frame(width: 2) }
        .accessibilityElement(children: .contain).accessibilityIdentifier("campus-waiting")
    }

    private func liveStrip(_ t: CampusTimeline) -> some View {
        HStack(spacing: 7) {
            ProgressView().controlSize(.mini)
            Text("Campus is working · \(t.live.isEmpty ? "starting" : t.live)").font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6).background(AgentState.working.color.opacity(0.10), in: Capsule())
        .accessibilityIdentifier("campus-live-strip")
    }
}


// MARK: - the composer, the Stop button and the undo banner (slice 2)

/// The write waiting out its undo window, sending, or just done: the way Conn's Herdr compose box shows it, with Now to skip the wait. Messages typed behind it wait
/// in a list under it, each with its own Take back; Undo on the first takes the whole lot back.
struct CampusHeldBanner: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore

    var body: some View {
        if let h = campus.held {
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    switch h.phase {
                    case .held: Image(systemName: "hourglass"); Text("Sending in \(h.secondsLeft) s: \(app.privacy ? "message" : h.label)").lineLimit(1)
                    case .sending: ProgressView().controlSize(.small); Text("Sending…")
                    case .sent: Image(systemName: "checkmark.circle.fill").foregroundStyle(AgentState.done.color); Text("Sent to Campus.\(more(h))")
                    case .undone: Image(systemName: "arrow.uturn.backward"); Text(h.restores ? "Taken back into the box.\(more(h))" : "Not sent.")
                    case .failed(let why): Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange); Text("Not sent: \(why).\(h.restores ? " Your text is back in the box.\(more(h))" : "")").lineLimit(2)
                    }
                    Spacer()
                    if h.phase == .held {
                        Button("Now") { campus.sendNow() }.buttonStyle(.borderless).keyboardShortcut(.return, modifiers: [.command, .shift])
                            .help("Skip the wait and send it now (\u{21E7}\u{2318}\u{21A9})").accessibilityIdentifier("campus-now")
                        Button(campus.waiting.isEmpty ? "Undo" : "Undo all") { campus.undo() }.buttonStyle(.borderless).keyboardShortcut("z", modifiers: .command)
                            .help(campus.waiting.isEmpty ? "Take it back (\u{2318}Z)" : "Take it back, and the \(campus.waiting.count) waiting behind it (\u{2318}Z)").accessibilityIdentifier("campus-undo")
                    }
                }
                ForEach(campus.waiting) { w in
                    HStack(spacing: 8) {
                        Image(systemName: "clock").foregroundStyle(.secondary)
                        Text("Next: \(app.privacy ? "message" : w.label)").lineLimit(1).foregroundStyle(.secondary)
                        Spacer()
                        Button("Take back") { campus.takeBack(w.id) }.buttonStyle(.borderless).help("Take this one out of the queue and back into its box").accessibilityIdentifier("campus-take-back")
                    }
                    .accessibilityElement(children: .contain).accessibilityIdentifier("campus-waiting")
                }
            }
            .font(.system(size: 12)).padding(.horizontal, 12).padding(.vertical, 7)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .padding(.horizontal, 12).padding(.top, 8)
            .accessibilityIdentifier("campus-held")
        }
    }

    /// " 2 waiting messages are back in the box too." when messages that waited behind the write were given back with it.
    private func more(_ h: CampusHeld) -> String { h.alsoReturned == 0 ? "" : " \(h.alsoReturned) waiting \(h.alsoReturned == 1 ? "message is" : "messages are") back in the box too." }
}

/// The header's star: keeps this conversation in the Reader column's starred row (and takes it out again).
struct CampusStarButton: View {
    @EnvironmentObject var app: AppModel
    let c: CampusConversation

    var body: some View {
        let on = app.campusIsStarred(c.id)
        Button { app.toggleCampusStar(c) } label: { Image(systemName: on ? "star.fill" : "star").font(.system(size: 11)).foregroundStyle(on ? Color.accentColor : Color.secondary) }
            .buttonStyle(.plain).help(on ? "Remove the star: this conversation leaves the Reader column's starred row" : "Star: keep this conversation in the Reader column's starred row")
            .accessibilityLabel(on ? "Remove star" : "Star conversation").accessibilityIdentifier("campus-star-button")
    }
}

struct CampusStopButton: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let c: CampusConversation

    var body: some View {
        if c.working && campus.link == .live {
            Button { app.campusStop(c) } label: { Label("Stop", systemImage: "stop.fill").font(.system(size: 11, weight: .medium)) }
                .controlSize(.small).tint(AgentState.blocked.color).help(campus.writesEnabled ? "Stop this run (interrupt)" : "Campus writes are off")
                .accessibilityIdentifier("campus-stop")
        }
    }
}

/// The composer: a message box, Send (Steer or Queue while a run is working), and the model and agent pickers. All of it is behind the "Campus writes" switch.
struct CampusComposer: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let c: CampusConversation
    let compact: Bool
    /// The reader's page has its own message bar for this conversation: this box steps aside (one box, not two), and the banner, the switch and the pickers stay.
    var pageBar = false
    @State private var text = ""
    @State private var confirm = false

    var body: some View {
        let on = campus.writesEnabled && campus.link == .live
        VStack(spacing: 6) {
            CampusHeldBanner(campus: campus)
            VStack(alignment: .leading, spacing: 5) {
                if !campus.writesEnabled {
                    HStack(spacing: 8) {
                        Label("Campus writes are off", systemImage: "lock.fill").font(.system(size: 11, weight: .medium)).foregroundStyle(Color.orange)
                        Button("Turn on…") { app.requestCampusWrites() }.buttonStyle(.link).font(.system(size: 11)).accessibilityIdentifier("campus-turn-on")
                        Spacer()
                        Button("Open in web") { if let u = campus.webURL(for: c) { NSWorkspace.shared.open(u) } }.controlSize(.small)
                    }
                } else if campus.link != .live {
                    Label(campus.link == .expired ? "Signed out of Campus: sign in to send" : campus.link == .blocked ? "Campus refused the connection: check Zscaler, then try again" : "Campus is not reachable", systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Color.orange)
                }
                if !pageBar { HStack(alignment: .bottom, spacing: 8) {
                    TextField(placeholder, text: $text, axis: .vertical)
                        .textFieldStyle(.plain).lineLimit(1...(compact ? 3 : 6)).font(.system(size: 13))
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.primary.opacity(0.10)))
                        .disabled(!on).opacity(on ? 1 : 0.55)
                        .accessibilityIdentifier("campus-input")
                    if c.working {
                        Button("Queue") { submit("queue") }.fixedSize().disabled(!on || trimmed.isEmpty).help("Send after the run ends")
                        Button("Steer") { submit("steer") }.fixedSize().keyboardShortcut(.return, modifiers: .command).disabled(!on || trimmed.isEmpty).help("Send now, into the run (⌘↩)")
                            .accessibilityIdentifier("campus-send")
                    } else {
                        Button("Send") { submit(nil) }.fixedSize().keyboardShortcut(.return, modifiers: .command).disabled(!on || trimmed.isEmpty).help("⌘↩ sends after a short undo window")
                            .accessibilityIdentifier("campus-send")
                    }
                } }
                if !compact { pickers(on: on) }
            }
            .padding(.horizontal, 12).padding(.bottom, 8).padding(.top, 2)
        }
        .background(.bar)
        .onReceive(app.campusDraftRestore.filter { $0.0 == c.id }) { _ in takeBackDrafts() }
        .onAppear { takeBackDrafts() }
        .accessibilityIdentifier("campus-composer")
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Put the texts that came back (an Undo, a failed send) in front of what is in the box now.
    private func takeBackDrafts() {
        guard let back = app.claimCampusDrafts(c.id) else { return }
        text = text.isEmpty ? back : back + "\n" + text
    }

    private var placeholder: String {
        if !campus.writesEnabled { return "Campus writes are off" }
        return c.working ? "Campus is working: Steer sends now, Queue sends after" : (c.needsYou ? "Answer the question above, or type another answer" : "Message Campus…")
    }

    private func submit(_ delivery: String?) {
        let t = trimmed
        guard !t.isEmpty else { return }
        if app.campusSend(t, to: c, delivery: delivery) { text = "" }
    }

    private func pickers(on: Bool) -> some View {
        HStack(spacing: 10) {
            let space = c.spaceID
            Text("Model").font(.system(size: 11)).foregroundStyle(.secondary)
            Menu(c.model ?? "default") {
                ForEach(campus.models[space] ?? []) { m in Button(m.label) { app.campusSetModel(m, for: c) } }
            }.menuStyle(.borderlessButton).fixedSize().disabled(!on || (campus.models[space] ?? []).isEmpty).accessibilityIdentifier("campus-model")
            Text("Agent").font(.system(size: 11)).foregroundStyle(.secondary)
            Menu(c.agent ?? "default") {
                ForEach(campus.agents[space] ?? []) { a in Button(a.label) { app.campusSetAgent(a, for: c) } }
            }.menuStyle(.borderlessButton).fixedSize().disabled(!on || (campus.agents[space] ?? []).isEmpty).accessibilityIdentifier("campus-agent")
            Spacer()
        }
    }
}
