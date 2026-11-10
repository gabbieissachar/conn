// The Watch view: 2 to 4 conversations side by side, each its own web view on the reader's lite page. It replaces the centre pane
// and the reader column while it is on (the full reader is unloaded for the time). Each column has a small header (the agent's
// name and Herdr's state for it) and a close button; its own scroll, and its own composer with the server's own checks, are the
// lite page's.
import SwiftUI
import ConnCore

private struct WatchSlot: Identifiable {
    let index: Int
    let column: WatchColumn?
    /// A column keeps its identity (and so its web view) when it moves or another session replaces its own.
    var id: Int { column?.id ?? -(index + 1) }
}

struct WatchArea: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var watch: WatchModel
    /// Narrower than this and the columns scroll sideways instead of squeezing the page.
    static let minColumnWidth: CGFloat = 300

    var body: some View {
        VStack(spacing: 0) {
            WatchBar(watch: watch)
            Divider()
            GeometryReader { g in
                let n = watch.count
                let w = max(WatchArea.minColumnWidth, (g.size.width - CGFloat(n - 1)) / CGFloat(n))
                let slots = watch.layout.slots.enumerated().map { WatchSlot(index: $0.offset, column: $0.element) }
                let row = HStack(spacing: 0) {
                    ForEach(slots) { slot in
                        WatchColumnView(watch: watch, slot: slot).frame(width: w)
                        if slot.index < n - 1 { Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1) }
                    }
                }
                if w * CGFloat(n) + CGFloat(n - 1) > g.size.width + 0.5 {
                    ScrollView(.horizontal) { row.frame(height: g.size.height) }
                } else {
                    row
                }
            }
        }
        .accessibilityIdentifier("watch-area")
    }
}

private struct WatchBar: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var watch: WatchModel

    var body: some View {
        HStack(spacing: 8) {
            // The columns take the room the sidebar gives up: hide it here as well as from the toolbar and Ctrl+Cmd+S.
            Button { app.sidebarVisible.toggle() } label: { Image(systemName: "sidebar.left") }
                .buttonStyle(.borderless).help(app.sidebarVisible ? "Hide the sidebar for wider columns (⌃⌘S)" : "Show the sidebar (⌃⌘S)")
                .accessibilityIdentifier("watch-sidebar-toggle")
            Image(systemName: "rectangle.split.3x1").foregroundStyle(.secondary)
            Text("Watch").font(.system(size: 12, weight: .semibold))
            Text("\(watch.layout.openCount) of \(watch.count) columns").font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(app.sidebarVisible ? "Click an agent to show it here" : "⌘K picks an agent to show here").font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
            Menu { WatchPresetMenuItems(watch: watch) } label: { Image(systemName: "bookmark") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Save the columns as a preset, or load one")
                .accessibilityIdentifier("watch-presets")
            Picker("Columns", selection: Binding(get: { watch.count }, set: { app.setWatchCount($0) })) {
                ForEach(Array(WatchLayout.allowedCounts), id: \.self) { Text("\($0)").tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 96)
            .help("How many columns (remembered)")
            .accessibilityIdentifier("watch-count")
        }
        .padding(.horizontal, 12).frame(height: 32)
        .accessibilityIdentifier("watch-bar")
    }
}

private struct WatchColumnView: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var watch: WatchModel
    let slot: WatchSlot
    @State private var flash = 0.0

    var body: some View {
        VStack(spacing: 0) {
            if let column = slot.column, let cid = CampusColumn.id(of: column.session) {
                // A Campus column (C5): the transcript and a live strip, drawn natively. It is not a reader session.
                CampusColumnHeader(campus: app.campus, id: cid, watch: watch, index: slot.index, column: column)
                Divider()
                WatchCueStrip(watch: watch, column: column, index: slot.index)
                CampusTranscriptView(campus: app.campus, id: cid, column: slot.index, hidden: watch.isHidden(column), landTick: watch.lands[column.session] ?? 0)
            } else if let column = slot.column {
                header(column)
                Divider()
                WatchCueStrip(watch: watch, column: column, index: slot.index)
                if let box = watch.box(for: column) { WatchWebPane(box: box) } else { Spacer() }
            } else {
                emptyColumn
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(Color.accentColor, lineWidth: 3).opacity(flash).allowsHitTesting(false))
        .onChange(of: slot.column.flatMap { watch.flashes[$0.id] }) { _, now in
            guard now != nil else { return }
            flash = 1
            withAnimation(.easeOut(duration: 1.4)) { flash = 0 }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("watch-column")
    }

    /// The agent running this session now, for its name and Herdr's state.
    private func agent(_ column: WatchColumn) -> Agent? {
        app.agent(forSession: column.session)
    }

    private func header(_ column: WatchColumn) -> some View {
        let a = agent(column)
        let name = a?.name ?? app.stars.label(for: column.session, agentNames: app.agentNamesBySession)
        return HStack(spacing: 6) {
            if let a = a {
                StateGlyph(state: a.state, size: 12)
            } else {
                Image(systemName: "questionmark.circle").foregroundStyle(.tertiary).frame(width: 16)
            }
            Text(name).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                .redacted(reason: app.privacy ? .placeholder : [])
                .help(app.privacy ? "Agent name" : name)
            if let a = a {
                Text(a.state.label).font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(a.state.waitsOnCaptain ? a.state.color : Color.secondary).lineLimit(1)
            } else {
                Text("no agent").font(.system(size: 10.5)).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 4)
            WatchSoloButton(watch: watch, column: column, index: slot.index)
            WatchHideButton(watch: watch, column: column, index: slot.index)
            Button { watch.close(column: slot.index) } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless).help("Close this column")
                .accessibilityIdentifier("watch-close")
        }
        .padding(.horizontal, 10).frame(height: 30)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    private var emptyColumn: some View {
        VStack(spacing: 6) {
            Image(systemName: "rectangle.dashed").font(.system(size: 22)).foregroundStyle(.tertiary)
            Text("Free column").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
            Text("Click an agent in the sidebar to show its conversation here.").font(.system(size: 11)).foregroundStyle(.tertiary).multilineTextAlignment(.center)
        }
        .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("watch-free-column")
    }
}

/// One column's page, with the same load and failure states as the Reader pane.
private struct WatchWebPane: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var box: WebBox

    var body: some View {
        ZStack {
            // A page that is about to be hidden is not drawn until its blur is in place.
            WebPaneRep(box: box).opacity(box.contentHidden && !box.hideApplied ? 0 : 1)
            if app.privacy { Rectangle().fill(Color(nsColor: .windowBackgroundColor)); Label("Privacy mode", systemImage: "eye.slash").foregroundStyle(.secondary) }
            if box.phase == .loading { ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(8) }
            if case .failed(let msg) = box.phase, !app.privacy {
                VStack(spacing: 6) {
                    Image(systemName: "network.slash").font(.system(size: 22))
                    Text("Reader not reachable").font(.system(size: 13, weight: .semibold))
                    Text(msg).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Retry") { box.reload() }
                }
                .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

/// A Campus column's header (the conversation's mark, title, a "Campus" tag, its state, a close button). It watches the feed, so the mark follows the run.
private struct CampusColumnHeader: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let id: String
    let watch: WatchModel
    let index: Int
    let column: WatchColumn

    var body: some View {
        let c = campus.conversation(id)
        HStack(spacing: 6) {
            if let c = c { StateGlyph(state: c.state, size: 12) } else { Image(systemName: "questionmark.circle").foregroundStyle(.tertiary).frame(width: 16) }
            Text(c?.title ?? "Campus conversation").font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                .redacted(reason: app.privacy ? .placeholder : [])
            Text("Campus").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(AgentState.working.color)
                .padding(.horizontal, 5).padding(.vertical, 1).background(AgentState.working.color.opacity(0.12), in: Capsule())
            if let c = c {
                Text(campus.link == .expired ? "signed out" : c.state.label).font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(campus.link == .live && c.state.waitsOnCaptain ? c.state.color : Color.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            WatchSoloButton(watch: watch, column: column, index: index)
            WatchHideButton(watch: watch, column: column, index: index)
            Button { watch.close(column: index) } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless).help("Close this column")
                .accessibilityIdentifier("watch-close")
        }
        .padding(.horizontal, 10).frame(height: 30)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
        .accessibilityIdentifier("watch-campus-header")
    }
}


/// The control that puts a column on its own: every other column's content is hidden (blurred) and this one is shown; pressed again it shows the others. Next to the eye button, which
/// does the same for one column. Off when there is no other column.
private struct WatchSoloButton: View {
    @ObservedObject var watch: WatchModel
    let column: WatchColumn
    let index: Int

    var body: some View {
        let alone = watch.layout.slots.enumerated().filter { $0.offset != index && $0.element != nil }.isEmpty
        let focused = watch.isFocused(column: index)
        Button { watch.focusColumn(index) } label: { Image(systemName: "scope") }
            .buttonStyle(.borderless)
            .foregroundStyle(focused ? Color.accentColor : Color.secondary)
            .disabled(alone)
            .help(alone ? "No other column to hide" : (focused ? "Show the other columns again" : "Hide every other column and keep only this one"))
            .accessibilityLabel(focused ? "Show the other columns" : "Only this column")
            .accessibilityIdentifier("watch-solo")
    }
}

/// The control that hides a column's content (blurs it, so it does not pull the eye) and shows it again. The header, with the name and the state, stays readable.
private struct WatchHideButton: View {
    @ObservedObject var watch: WatchModel
    let column: WatchColumn
    let index: Int

    var body: some View {
        let hidden = watch.isHidden(column)
        Button { watch.toggleHidden(column: index) } label: { Image(systemName: hidden ? "eye.slash.fill" : "eye") }
            .buttonStyle(.borderless)
            .foregroundStyle(hidden ? Color.accentColor : Color.secondary)
            .help(hidden ? "Show this column's conversation" : "Hide this column's conversation (blurred). A cue shows here when its turn ends")
            .accessibilityLabel(hidden ? "Show conversation" : "Hide conversation")
            .accessibilityIdentifier("watch-hide")
    }
}

/// What a hidden column's session did while it was hidden: its turn ended (finished, or ended on a question for the person). It stays until the column is shown, and showing
/// it lands on the reply that turn ended with.
private struct WatchCueStrip: View {
    @ObservedObject var watch: WatchModel
    let column: WatchColumn
    let index: Int

    var body: some View {
        if let cue = watch.cue(column), watch.isHidden(column) {
            let color = cue == .finished ? AgentState.done.color : AgentState.blocked.color
            HStack(spacing: 6) {
                Image(systemName: cue == .finished ? "checkmark.circle.fill" : "exclamationmark.circle.fill").foregroundStyle(color)
                Text(cue == .finished ? "Finished while hidden" : "Needs you").font(.system(size: 11.5, weight: .semibold))
                if let at = watch.cueTime(column) { Text(at, style: .time).font(.system(size: 11)).foregroundStyle(.secondary) }
                Spacer(minLength: 4)
                Button("Show") { watch.toggleHidden(column: index) }.controlSize(.small)
                    .help("Show the conversation, at the reply this turn ended with")
                    .accessibilityIdentifier("watch-cue-show")
            }
            .padding(.horizontal, 10).frame(height: 28)
            .background(color.opacity(0.16))
            .overlay(alignment: .bottom) { Rectangle().fill(color.opacity(0.5)).frame(height: 1) }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(cue == .finished ? "Finished while hidden" : "Needs you")
            .accessibilityIdentifier("watch-cue")
        }
    }
}
