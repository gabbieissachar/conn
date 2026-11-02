// The window: sidebar (spaces and agents), a centre column (Agent, Editor or Herdr's screen), and the web column
// (reader and organizer), plus the status bar, quick switcher and menu-bar item.
import SwiftUI
import WebKit
import HelmCore

struct SidebarView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            spaces.frame(maxHeight: 236)
            Divider()
            agents.frame(maxHeight: .infinity)
        }
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.55))
    }

    private func header(_ title: String, trailing: String) -> some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(.secondary)
            Spacer()
            Text(trailing).font(.system(size: 11)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 4)
    }

    private var spaces: some View {
        VStack(spacing: 0) {
            header("SPACES", trailing: "\(app.snapshot.workspaces.count)")
            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(app.snapshot.workspaces) { w in
                        SidebarRow(selected: w.id == app.selectedWorkspaceID, action: { app.selectWorkspace(w.id) }) {
                            StateGlyph(state: w.state, size: 11)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(w.label).font(.system(size: 13, weight: .medium)).lineLimit(1).truncationMode(.middle)
                                    .redacted(reason: app.privacy ? .placeholder : [])
                                Text("\(w.tabCount) tab\(w.tabCount == 1 ? "" : "s")").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(.horizontal, 6).padding(.bottom, 6)
            }
        }
    }

    private var agents: some View {
        let list = app.snapshot.prioritized
        return VStack(spacing: 0) {
            header("AGENTS", trailing: "working first")
            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, a in
                        SidebarRow(selected: a.id == app.selectedPaneID, action: { app.select(a.id) }) {
                            StateGlyph(state: a.state)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.name).font(.system(size: 13, weight: .medium)).lineLimit(1).truncationMode(.middle)
                                    .redacted(reason: app.privacy ? .placeholder : [])
                                Text("\(a.harness) · \(a.state.label)").font(.system(size: 11))
                                    .foregroundStyle(a.state.waitsOnCaptain ? a.state.color : Color.secondary)
                            }
                            Spacer(minLength: 0)
                            if i < 9 { Text("⌘\(i + 1)").font(.system(size: 10.5, design: .rounded)).foregroundStyle(.tertiary) }
                        }
                    }
                }
                .padding(.horizontal, 6).padding(.bottom, 6)
            }
        }
    }
}

struct SidebarRow<Content: View>: View {
    let selected: Bool
    let action: () -> Void
    @ViewBuilder let content: Content
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) { content }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(selected ? Color.accentColor.opacity(0.20) : (hover ? Color.primary.opacity(0.06) : Color.clear),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .onTapGesture(perform: action)
    }
}

// MARK: - Web column

struct WebColumn: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var box: WebBox

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if box.kind == .reader {
                    // The tab above already says "Reader": the row is for the starred sessions.
                    StarredBar(starred: app.stars, box: box)
                } else {
                    Image(systemName: box.kind.symbol).foregroundStyle(.secondary)
                    Text(box.kind.rawValue).font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: 4)
                }
                switch box.phase {
                case .loading: ProgressView().controlSize(.small)
                case .ready: if let s = box.loadSeconds { Text(String(format: "%.1fs", s)).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary) }
                default: EmptyView()
                }
                Button { box.reload() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).help("Reload")
            }
            .padding(.horizontal, 12).frame(height: 32)
            Divider()
            ZStack {
                WebPaneRep(box: box)
                if app.privacy { Rectangle().fill(Color(nsColor: .windowBackgroundColor)); Label("Privacy mode", systemImage: "eye.slash").foregroundStyle(.secondary) }
                if case .failed(let msg) = box.phase, !app.privacy {
                    VStack(spacing: 6) {
                        Image(systemName: "network.slash").font(.system(size: 22))
                        Text("\(box.kind.rawValue) server not reachable").font(.system(size: 13, weight: .semibold))
                        Text(msg).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        Button("Retry") { box.reload() }
                    }
                    .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }
}

/// The Reader pane's header row: one chip per starred session, in the order the captain arranged. A click opens that
/// session in the reader; the chip for the session on screen is filled; a drag onto another chip moves it there.
/// More chips than fit scroll sideways (the selected one is brought into view), so none is hidden in a menu and every
/// one stays a drop target. With nothing starred the row says where to star.
struct StarredBar: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var starred: StarredSessions
    @ObservedObject var box: WebBox
    @State private var dragging: String?

    var body: some View {
        let selected = StarSelection.selected(convs: starred.order, shown: box.shownSession)
        let names = app.agentNamesBySession
        Group {
            if starred.order.isEmpty {
                Text("Star a session in the reader to keep it here").font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
                    .accessibilityIdentifier("starred-empty")
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(starred.order, id: \.self) { conv in
                                chip(conv, label: starred.label(for: conv, agentNames: names), selected: conv == selected)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .onChange(of: selected) { _, now in if let c = now { withAnimation { proxy.scrollTo(c, anchor: .center) } } }
                    // Also when the row first appears or the column is resized: the chip on screen must not sit out of sight.
                    .onAppear { reveal(selected, proxy) }
                    .background(GeometryReader { g in Color.clear.onChange(of: g.size.width) { _, _ in reveal(selected, proxy) } })
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func reveal(_ conv: String?, _ proxy: ScrollViewProxy) {
        guard let c = conv else { return }
        DispatchQueue.main.async { proxy.scrollTo(c, anchor: .center) }
    }

    private func chip(_ conv: String, label: String, selected: Bool) -> some View {
        Text(label)
            .font(.system(size: 10.5, weight: selected ? .semibold : .regular))
            .lineLimit(1).truncationMode(.middle)
            .frame(maxWidth: 150)
            .padding(.horizontal, 8).padding(.vertical, 2.5)
            .background(selected ? Color.accentColor.opacity(0.24) : Color.primary.opacity(0.07), in: Capsule())
            .redacted(reason: app.privacy ? .placeholder : [])
            .contentShape(Capsule())
            .onTapGesture { app.openStarred(conv) }
            .onDrag { dragging = conv; return NSItemProvider(object: conv as NSString) }
            .onDrop(of: [.plainText], delegate: ChipDrop(target: conv, starred: starred, dragging: $dragging))
            .help(app.privacy ? "Starred session" : "\(label) (drag to reorder)")
            .id(conv)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(app.privacy ? "Starred session" : label)
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { app.openStarred(conv) }
            .accessibilityIdentifier("starred-chip")
    }
}

/// A chip dragged over another takes its place while the pointer is over it, so the row shows the result before the drop.
struct ChipDrop: DropDelegate {
    let target: String
    let starred: StarredSessions
    @Binding var dragging: String?

    func dropEntered(info: DropInfo) {
        if let d = dragging, d != target { withAnimation(.easeInOut(duration: 0.15)) { starred.move(d, onto: target) } }
    }
    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
    func performDrop(info: DropInfo) -> Bool { dragging = nil; return true }
}

struct WebTabsColumn: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: Binding(get: { app.webTab }, set: { app.webTab = $0; app.pinReader() })) {
                ForEach(WebKind.allCases) { k in Label(k.rawValue, systemImage: k.symbol).tag(k) }
            }
            .pickerStyle(.segmented).labelsHidden()
            .padding(.horizontal, 10).frame(height: 36)
            Divider()
            WebColumn(box: app.web.box(app.webTab))
        }
    }
}

// MARK: - Status bar, switcher, menu bar

struct StatusBar: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(linkText)
            Text("·").foregroundStyle(.tertiary)
            Text("\(app.snapshot.agents.count) agents in \(app.snapshot.workspaces.count) spaces")
            Text("·").foregroundStyle(.tertiary)
            Text(app.streamVerdict.allowsStream ? "stream \(app.renderer == .swiftTerm ? "SwiftTerm" : "grid")" : "text panes")
            Spacer()
            Text(app.statsLine).font(.system(size: 11, design: .monospaced))
        }
        .font(.system(size: 11)).foregroundStyle(.secondary)
        .padding(.horizontal, 12).frame(height: 24)
        .background(.bar)
    }

    private var color: Color {
        switch app.store.link {
        case .live: return .green
        case .fixture: return .purple
        case .connecting: return .yellow
        case .reconnecting: return .red
        }
    }

    private var linkText: String {
        let s = app.endpoint.session
        switch app.store.link {
        case .live: return "Live · session \(s) · \(app.writesEnabled ? "sending on" : "observe only")"
        case .fixture: return "Fixture data"
        case .connecting: return "Connecting to Herdr…"
        case .reconnecting(let why): return "Reconnecting (\(why)) · showing last state"
        }
    }
}

struct QuickSwitcher: View {
    @EnvironmentObject var app: AppModel
    @FocusState private var focused: Bool
    @State private var index = 0

    private var matches: [Agent] {
        let q = app.switcherQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let all = app.snapshot.prioritized
        guard !q.isEmpty else { return all }
        return all.filter { a in
            let space = app.snapshot.workspace(a.workspaceID)?.label.lowercased() ?? ""
            return a.name.lowercased().contains(q) || space.contains(q) || a.state.label.contains(q)
        }
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.28).ignoresSafeArea().onTapGesture { app.showSwitcher = false }
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Jump to an agent, space or state", text: $app.switcherQuery)
                        .textFieldStyle(.plain).font(.system(size: 17)).focused($focused)
                        .onSubmit { open() }
                }
                .padding(14)
                Divider()
                ScrollView {
                    VStack(spacing: 1) {
                        ForEach(Array(matches.prefix(12).enumerated()), id: \.element.id) { i, a in
                            HStack(spacing: 8) {
                                StateGlyph(state: a.state)
                                Text(a.name).font(.system(size: 14, weight: .medium)).redacted(reason: app.privacy ? .placeholder : [])
                                Text(app.snapshot.workspace(a.workspaceID)?.label ?? "").font(.system(size: 12)).foregroundStyle(.secondary)
                                    .redacted(reason: app.privacy ? .placeholder : [])
                                Spacer()
                                StateChip(state: a.state)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(i == index ? Color.accentColor.opacity(0.22) : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .contentShape(Rectangle())
                            .onTapGesture { index = i; open() }
                        }
                        if matches.isEmpty { Text("No match").foregroundStyle(.secondary).padding(20) }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 360)
                Divider()
                HStack(spacing: 14) {
                    Text("↑↓ move").font(.system(size: 11)); Text("↩ open").font(.system(size: 11)); Text("esc close").font(.system(size: 11))
                    Spacer()
                    Text("⌘J next waiting").font(.system(size: 11))
                }
                .foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 8)
            }
            .frame(width: 560)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.12)))
            .shadow(color: .black.opacity(0.35), radius: 28, y: 12)
            .frame(maxHeight: .infinity, alignment: .top).padding(.top, 90)
            .onKeyPress(.upArrow) { index = max(0, index - 1); return .handled }
            .onKeyPress(.downArrow) { index = min(max(0, min(matches.count, 12) - 1), index + 1); return .handled }
            .onKeyPress(.escape) { app.showSwitcher = false; return .handled }
        }
        .onAppear { focused = true; index = 0 }
        .onChange(of: app.switcherQuery) { _, _ in index = 0 }
    }

    private func open() {
        let m = matches
        guard index < m.count else { return }
        app.select(m[index].id)
        app.showSwitcher = false
        app.switcherQuery = ""
    }
}

struct WaitingMenu: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            let w = app.waiting
            Text(w.isEmpty ? "Nothing is waiting on you" : "Waiting on you (\(w.count))").font(.system(size: 13, weight: .semibold)).padding(.bottom, 2)
            ForEach(w) { a in
                Button {
                    app.select(a.id)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                } label: {
                    HStack(spacing: 8) {
                        StateGlyph(state: a.state)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(a.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
                            Text("\(app.snapshot.workspace(a.workspaceID)?.label ?? "") · \(a.state.label)").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Divider().padding(.vertical, 4)
            Button("Open Helm") { NSApplication.shared.activate(ignoringOtherApps: true) }.buttonStyle(.plain)
            Button("Quit Helm") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain)
        }
        .padding(12).frame(width: 300, alignment: .leading)
    }
}

struct MenuBarLabel: View {
    @ObservedObject var app: AppModel
    var body: some View {
        let n = app.waiting.count
        HStack(spacing: 3) {
            Image(systemName: n > 0 ? "bell.badge.fill" : "bell")
            if n > 0 { Text("\(n)") }
        }
    }
}

// MARK: - Window content

/// A draggable divider that resizes the column on its trailing side.
struct ColumnHandle: View {
    @Binding var width: CGFloat
    var min: CGFloat = 300
    var max: CGFloat = 900
    @State private var start: CGFloat?

    var body: some View {
        Rectangle().fill(Color.primary.opacity(0.10)).frame(width: 1)
            .overlay(Color.clear.frame(width: 9).contentShape(Rectangle())
                .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
                .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { v in
                        if start == nil { start = width }
                        width = Swift.min(max, Swift.max(min, (start ?? width) - v.translation.width))
                    }
                    .onEnded { _ in start = nil }))
    }
}

/// Reports whether the window is on screen, so pane streams can pause while it is covered or minimised.
struct OcclusionWatcher: NSViewRepresentable {
    let onChange: (Bool) -> Void
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async {
            guard let w = v.window else { return }
            NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: w, queue: .main) { _ in
                onChange(w.occlusionState.contains(.visible))
            }
        }
        return v
    }
    func updateNSView(_ v: NSView, context: Context) {}
}

struct MainView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                if app.sidebarVisible {
                    SidebarView().frame(width: 250)
                    Divider()
                }
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        centre.frame(minWidth: 420, maxWidth: .infinity)
                        if app.showWeb {
                            ColumnHandle(width: $app.webWidth)
                            WebTabsColumn().frame(width: app.webWidth)
                        }
                    }
                    Divider()
                    StatusBar()
                }
            }
            .navigationTitle(app.privacy ? "Helm" : (app.mode == .editor ? (app.editor.current?.title ?? "Helm") : (app.selectedAgent?.name ?? "Helm")))
            .navigationSubtitle(app.privacy ? "privacy mode" : subtitle)
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button { app.sidebarVisible.toggle() } label: { Image(systemName: "sidebar.left") }.help("Show or hide the sidebar (⌃⌘S)")
                }
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $app.mode) {
                        ForEach(CenterMode.allCases) { m in Label(m.rawValue, systemImage: m.symbol).tag(m) }
                    }
                    .pickerStyle(.segmented).labelsHidden().frame(width: 330)
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Toggle(isOn: $app.showWeb) { Image(systemName: "sidebar.right") }.help("Show the reader and organizer (⌥⌘R)")
                    Toggle(isOn: $app.readerFollows) { Image(systemName: "pin") }.help("Reader follows the selected agent (⌥⌘F)")
                    Toggle(isOn: $app.privacy) { Image(systemName: "eye.slash") }.help("Privacy mode for screen sharing: hides content (⇧⌘B)")
                    Button { app.showSwitcher = true } label: { Image(systemName: "magnifyingglass") }.help("Quick switcher (⌘K)")
                }
            }
            if app.showSwitcher { QuickSwitcher().transition(.opacity) }
            if let t = app.toastText {
                Text(t).font(.system(size: 12, weight: .medium)).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule()).shadow(radius: 8)
                    .frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 44)
            }
        }
        .background(OcclusionWatcher { app.setWindowVisible($0) })
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            // Files dropped on the window open in the editor. Only regular files; folders and apps are ignored.
            var opened = false
            for p in providers where p.hasItemConformingToTypeIdentifier("public.file-url") {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    guard let url = url else { return }
                    var isDir: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue else { return }
                    DispatchQueue.main.async { app.editor.open(url); app.mode = .editor }
                }
                opened = true
            }
            return opened
        }
        .onChange(of: app.showWeb) { _, _ in app.pinReader() }
    }

    private var subtitle: String {
        if app.mode == .editor { return app.editor.current?.url?.deletingLastPathComponent().path ?? "" }
        guard let a = app.selectedAgent else { return "" }
        return "\(app.snapshot.workspace(a.workspaceID)?.label ?? "") · \(a.state.label)"
    }

    @ViewBuilder private var centre: some View {
        switch app.mode {
        case .agent: PanesArea()
        case .editor: EditorArea(model: app.editor)
        case .herdr: FallbackPane()
        }
    }
}
