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
                ForEach(Array(form.questions.enumerated()), id: \.offset) { _, q in
                    Text(q.text).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    FlowLayout(spacing: 6, rowSpacing: 6) { ForEach(q.options, id: \.self) { OptionChip(label: $0, on: q.pick == $0) } }
                }
                CampusAnswerControls(form: form, c: c)
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

/// Slice 1 reads only: the card points at Campus's own page. (Slice 2 puts the answer buttons here.)
struct CampusAnswerControls: View {
    @EnvironmentObject var app: AppModel
    let form: CampusForm
    let c: CampusConversation

    var body: some View {
        HStack(spacing: 8) {
            Button("Answer in web") { if let u = app.campus.webURL(for: c) { NSWorkspace.shared.open(u) } }.controlSize(.small)
            Text("Reading only: answer in Campus.").font(.system(size: 11)).foregroundStyle(.secondary)
        }
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
        let mono = Font.system(size: 12, design: .monospaced)
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
        case .tool:
            gutter("⚙", VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(i.tool.isEmpty ? "tool" : i.tool).font(mono.weight(.semibold))
                    Text(i.argument).font(mono).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).redacted(reason: app.privacy ? .placeholder : [])
                    if !i.detail.isEmpty { Text(i.detail).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary) }
                    switch i.toolStatus {
                    case .running: ProgressView().controlSize(.mini)
                    case .ok: Text("✓").foregroundStyle(AgentState.done.color)
                    case .failed: Text("✕").foregroundStyle(AgentState.blocked.color)
                    case .aborted: Text("■ stopped").font(.system(size: 11)).foregroundStyle(AgentState.blocked.color)
                    }
                }
                if !i.output.isEmpty {
                    Text(i.output).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(4)
                        .padding(6).frame(maxWidth: .infinity, alignment: .leading).background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 5))
                        .redacted(reason: app.privacy ? .placeholder : [])
                }
            })
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
    @State private var tick = 0
    @State private var openTools: Set<String> = []

    var body: some View {
        let _ = tick
        Group {
            if let c = campus.conversation(id) {
                let t = campus.timeline(id) ?? CampusTimeline()
                VStack(spacing: 0) {
                    head(c, t)
                    Divider()
                    if campus.link == .expired { ExpiredBanner() }
                    if campus.link == .starting && !t.loaded { StartingBox() } else { page(c, t) }
                    CampusComposer(campus: campus, c: c, compact: true)
                }
                .accessibilityIdentifier("campus-transcript")
            } else {
                Text("That Campus conversation is not in the list").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .modifier(TimelineSubscription(campus: campus, id: id, tick: $tick))
        .id(id)
    }

    private func badge(_ c: CampusConversation) -> (String, Color) {
        switch campus.link {
        case .live: return ("live", AgentState.done.color)
        case .starting: return ("starting", .yellow)
        case .expired: return ("signed out", AgentState.blocked.color)
        default: return ("offline", .gray)
        }
    }

    private func head(_ c: CampusConversation, _ t: CampusTimeline) -> some View {
        let (word, tint) = badge(c)
        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text(c.title).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.tail).redacted(reason: app.privacy ? .placeholder : [])
                Spacer(minLength: 4)
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
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(tools) { t in Text("\(t.tool) \(t.argument)\(t.detail.isEmpty ? "" : " · " + t.detail)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1).redacted(reason: app.privacy ? .placeholder : []) }
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
            ForEach(Array(f.questions.enumerated()), id: \.offset) { _, q in
                Text(q.text).font(.system(size: 13, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                FlowLayout(spacing: 6, rowSpacing: 6) { ForEach(q.options, id: \.self) { OptionChip(label: $0, on: q.pick == $0) } }
            }
            CampusAnswerControls(form: f, c: c)
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

// MARK: - the parts slice 2 fills

/// The composer. Slice 1 reads only, so this is a note and a way into Campus's own page.
struct CampusComposer: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let c: CampusConversation
    let compact: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(.tertiary)
            Text("Reading only. Reply in Campus.").font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer()
            Button("Open in web") { if let u = campus.webURL(for: c) { NSWorkspace.shared.open(u) } }.controlSize(.small)
        }
        .padding(.horizontal, 12).padding(.vertical, 8).background(.bar)
        .accessibilityIdentifier("campus-composer")
    }
}

struct CampusStopButton: View {
    @ObservedObject var campus: CampusStore
    let c: CampusConversation
    var body: some View { EmptyView() }
}
