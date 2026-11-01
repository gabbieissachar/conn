// Panes: the tab bar, a pane column (header, terminal, state banners), the compose bar's home, and the fallback screen.
// The terminal itself is a native NSView: SwiftTerm's view (default) or the cell-grid view, chosen at launch.
import SwiftUI
import HelmCore
import HelmTerminal

/// Hosts the SwiftTerm view at the pane's own grid, with the font chosen so every column fits, aligned to the top
/// (or to the bottom when the pane is taller than the view, where the live prompt is).
final class PaneHostView: NSView {
    private(set) var terminal: HelmTerminalView?
    private let pad: CGSize = CGSize(width: 8, height: 6)
    private var refitting = false

    override var isFlipped: Bool { false }

    func attach(_ t: HelmTerminalView) {
        guard terminal !== t || t.superview !== self else { return }
        t.removeFromSuperview()
        terminal = t
        wantsLayer = true
        layer?.masksToBounds = true
        t.onGridChange = { [weak self] in self?.refit() }
        addSubview(t)
        refit()
    }

    override func layout() { super.layout(); refit() }

    func refit() {
        guard !refitting, let t = terminal else { return }
        refitting = true; defer { refitting = false }
        let availW = bounds.width - 2 * pad.width
        guard availW > 40, bounds.height > 40 else { return }
        var pts: CGFloat = 13
        while pts > 7, HelmTerminalView.cellWidth(forPoints: pts) * CGFloat(t.gridCols) > availW { pts -= 0.5 }
        t.setGrid(cols: t.gridCols, rows: t.gridRows, fontPoints: pts)
        let h = t.frame.height
        let y = h > bounds.height - 2 * pad.height ? pad.height : bounds.height - pad.height - h
        t.setFrameOrigin(NSPoint(x: pad.width, y: y))
    }
}

struct SwiftTermPaneRep: NSViewRepresentable {
    let engine: SwiftTermEngine
    let theme: TerminalTheme

    func makeNSView(context: Context) -> PaneHostView {
        let v = PaneHostView()
        engine.view.apply(theme: theme)
        v.attach(engine.view)
        return v
    }

    func updateNSView(_ v: PaneHostView, context: Context) {
        if engine.view.theme.bg != theme.bg { engine.view.apply(theme: theme) }
        v.attach(engine.view)
    }
}

struct GridPaneRep: NSViewRepresentable {
    let session: PaneSession
    let engine: GridEngine
    let theme: TerminalTheme
    var redact = false

    func makeNSView(context: Context) -> GridTerminalNSView {
        let v = GridTerminalNSView(frame: .zero)
        v.screen = engine.screen
        v.theme = theme
        v.redact = redact
        session.onApplied = { [weak v] in v?.screenChanged() }
        return v
    }

    func updateNSView(_ v: GridTerminalNSView, context: Context) {
        v.theme = theme
        v.redact = redact
        v.screen = engine.screen
        session.onApplied = { [weak v] in v?.screenChanged() }
    }
}

struct TabBarView: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        let tabs = app.snapshot.tabs(in: app.selectedWorkspaceID)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(tabs) { t in
                    let selected = t.id == app.selectedAgent?.tabID
                    HStack(spacing: 6) {
                        StateGlyph(state: t.state, size: 10)
                        Text(t.label).font(.system(size: 12, weight: selected ? .semibold : .regular)).lineLimit(1)
                            .redacted(reason: app.privacy ? .placeholder : [])
                        if t.paneCount > 1 { Text("×\(t.paneCount)").font(.system(size: 10)).foregroundStyle(.secondary) }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(selected ? Color.primary.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture { app.selectTab(t) }
                }
            }
            .padding(.horizontal, 10)
        }
        .frame(height: 36)
    }
}

struct AccessBadge: View {
    let writable: Bool
    let compact: Bool

    var body: some View {
        Group {
            if writable {
                if compact { Image(systemName: "pencil") } else { Label("CAN SEND", systemImage: "pencil") }
            } else {
                if compact { Image(systemName: "lock.fill") } else { Label("OBSERVE ONLY", systemImage: "lock.fill") }
            }
        }
        .font(.system(size: 9.5, weight: .bold)).tracking(0.5)
        .foregroundStyle(writable ? Color.green : Color.orange)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background((writable ? Color.green : Color.orange).opacity(0.14), in: Capsule())
        .fixedSize()
        .help(writable ? "Helm may send text to this session from the compose box. The pane itself stays observe-only."
                       : "This pane is an observer stream. Helm sends nothing to this session.")
    }
}

struct PaneColumn: View {
    @EnvironmentObject var app: AppModel
    @Environment(\.colorScheme) var scheme
    @ObservedObject var session: PaneSession
    let agent: Agent?
    let isCompare: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let a = agent {
                    StateGlyph(state: a.state, size: 12)
                    Text(a.name).font(.system(size: 13, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                        .frame(minWidth: 60, alignment: .leading)
                        .redacted(reason: app.privacy ? .placeholder : [])
                    StateChip(state: a.state).fixedSize()
                }
                Spacer(minLength: 4)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        if let a = agent {
                            Text(a.cwdShort).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                                .redacted(reason: app.privacy ? .placeholder : [])
                        }
                        AccessBadge(writable: app.writesEnabled, compact: false)
                        Text("\(session.cols)×\(session.rows)").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary)
                    }
                    .fixedSize()
                    AccessBadge(writable: app.writesEnabled, compact: true)
                }
                .layoutPriority(1)
                if isCompare {
                    Button { app.toggleCompare() } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless).help("Close the comparison pane")
                }
            }
            .padding(.horizontal, 12).frame(height: 32)
            Divider()
            if case .textOnly(let why) = app.streamVerdict {
                HStack(spacing: 6) {
                    Image(systemName: "text.alignleft")
                    Text("Text view: \(why)").lineLimit(2)
                }
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .padding(.horizontal, 12).padding(.vertical, 5).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.yellow.opacity(0.12))
            }
            ZStack {
                terminal
                    .opacity(app.store.link == .live || app.store.link == .fixture ? 1 : 0.45)
                if app.privacy {
                    Rectangle().fill(app.terminalTheme.bg.swiftUI)
                    VStack(spacing: 6) {
                        Image(systemName: "eye.slash").font(.system(size: 22))
                        Text("Privacy mode").font(.system(size: 12, weight: .medium))
                    }.foregroundStyle(.secondary)
                } else {
                    overlay
                }
            }
        }
    }

    @ViewBuilder private var terminal: some View {
        if let e = session.engine as? SwiftTermEngine {
            SwiftTermPaneRep(engine: e, theme: app.terminalTheme)
        } else if let g = session.engine as? GridEngine {
            GridPaneRep(session: session, engine: g, theme: app.terminalTheme, redact: app.privacy)
        }
    }

    @ViewBuilder private var overlay: some View {
        switch session.state {
        case .idle, .starting:
            if session.paneID != nil { Text("Connecting to pane…").font(.system(size: 12)).foregroundStyle(.secondary) }
        case .reconnecting(let attempt, let reason):
            banner(icon: "arrow.triangle.2.circlepath", title: "Reconnecting to the pane", detail: "Attempt \(attempt). \(reason)")
        case .failed(let reason):
            banner(icon: "exclamationmark.triangle", title: "The pane stream stopped", detail: reason)
        case .live:
            EmptyView()
        }
    }

    private func banner(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 20))
            Text(title).font(.system(size: 12, weight: .medium))
            Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(3)
        }
        .padding(14).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .padding(20)
    }
}

extension NSColor {
    var swiftUI: Color { Color(nsColor: self) }
}

struct PanesArea: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            TabBarView()
            Divider()
            HStack(spacing: 0) {
                PaneColumn(session: app.primary, agent: app.selectedAgent, isCompare: false).frame(maxWidth: .infinity)
                if app.comparePaneID != nil {
                    Divider()
                    PaneColumn(session: app.secondary, agent: app.compareAgent, isCompare: true).frame(maxWidth: .infinity)
                }
            }
            Divider()
            ComposeBar()
        }
    }
}

// MARK: - Herdr's own screen

struct FallbackPane: View {
    @EnvironmentObject var app: AppModel
    @State private var tick = 0

    var body: some View {
        let running = app.fallback.running
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.inset.filled.and.person.filled").foregroundStyle(.secondary)
                Text("Herdr's own screen").font(.system(size: 13, weight: .semibold))
                Spacer()
                if running { Button("Stop") { app.fallback.stop() }.controlSize(.small) }
            }
            .padding(.horizontal, 12).frame(height: 32)
            Divider()
            if running {
                FallbackRep(controller: app.fallback)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "terminal").font(.system(size: 26)).foregroundStyle(.tertiary)
                    Text("Herdr's screen, as Herdr draws it").font(.system(size: 14, weight: .medium))
                    Text("This starts a Herdr client attached to session \(app.endpoint.session). It is interactive: keys you type go to Herdr, and as one more attached client it takes part in Herdr's own pane sizing. Use it when the native panes are unavailable, for example after a Herdr update.")
                        .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                    if let code = app.fallback.exitCode { Text("Last run ended with exit code \(code).").font(.system(size: 11)).foregroundStyle(.secondary) }
                    if FallbackTerminalController.command(for: app.endpoint) == nil {
                        Text("The herdr command was not found.").font(.system(size: 12)).foregroundStyle(.red)
                    } else {
                        Button("Attach to \(app.endpoint.session)") { app.fallback.start(endpoint: app.endpoint, theme: app.terminalTheme) }
                            .buttonStyle(.borderedProminent)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { app.fallback.onStateChange = { tick += 1 } }
        .id(tick)
    }
}

struct FallbackRep: NSViewRepresentable {
    let controller: FallbackTerminalController
    func makeNSView(context: Context) -> NSView {
        let host = NSView()
        let v = controller.view
        v.removeFromSuperview()
        v.frame = host.bounds
        v.autoresizingMask = [.width, .height]
        host.addSubview(v)
        return host
    }
    func updateNSView(_ host: NSView, context: Context) {
        let v = controller.view
        if v.superview !== host { v.removeFromSuperview(); v.frame = host.bounds; v.autoresizingMask = [.width, .height]; host.addSubview(v) }
    }
}
