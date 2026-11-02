// A pane's history, shown in place of its live view. A live stream pane cannot scroll (Herdr's frames never scroll, so a
// terminal fed them has no scrollback), so earlier output comes from `pane.read` (source recent, plain text) as a
// scrollable snapshot. The live view keeps drawing underneath; "Back to live" removes this view and nothing else.
import SwiftUI
import ConnCore
import ConnTerminal

struct PaneHistoryView: View {
    @ObservedObject var history: PaneHistory
    let theme: TerminalTheme
    let fontPoints: CGFloat
    let refresh: () -> Void
    let live: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                Text("History").font(.system(size: 12, weight: .semibold))
                if let at = history.loadedAt {
                    Text("snapshot \(at.formatted(date: .omitted, time: .standard))").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                Button("Refresh", action: refresh).controlSize(.small).help("Read the history again, newest at the bottom")
                Button("Copy") { if let t = history.text { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string) } }
                    .controlSize(.small).disabled(history.text == nil)
                Button { live() } label: { Label("Back to live", systemImage: "dot.radiowaves.left.and.right") }
                    .controlSize(.small).keyboardShortcut(.cancelAction).help("Show the live pane again (Esc or ⌘Y)")
            }
            .padding(.horizontal, 12).frame(height: 30)
            .background(.bar)
            Divider()
            switch history.phase {
            case .loading:
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready(let t):
                HistoryText(text: t, theme: theme, fontPoints: fontPoints, snapshotID: history.loadedAt)
            case .failed(let why):
                Text(why).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(30)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.bg.swiftUI)
    }
}

/// Read-only text with the system find bar (Cmd+F), in the pane's colours, scrolled to the end (the newest output) each
/// time a snapshot arrives. It does not move while it is just being looked at.
struct HistoryText: NSViewRepresentable {
    let text: String
    let theme: TerminalTheme
    let fontPoints: CGFloat
    let snapshotID: Date?

    final class Coordinator { var shown: Date? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = true
        let tv = scroll.documentView as! NSTextView
        tv.isEditable = false
        tv.isRichText = false
        tv.usesFindBar = true
        tv.isIncrementalSearchingEnabled = true
        tv.textContainerInset = NSSize(width: 12, height: 8)
        apply(to: scroll, tv)
        tv.string = text
        context.coordinator.shown = snapshotID
        DispatchQueue.main.async { tv.scrollToEndOfDocument(nil) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        apply(to: scroll, tv)
        if context.coordinator.shown != snapshotID {
            context.coordinator.shown = snapshotID
            tv.string = text
            DispatchQueue.main.async { tv.scrollToEndOfDocument(nil) }
        }
    }

    private func apply(to scroll: NSScrollView, _ tv: NSTextView) {
        scroll.backgroundColor = theme.bg
        tv.backgroundColor = theme.bg
        tv.textColor = theme.fg
        tv.insertionPointColor = theme.fg
        let f = NSFont.monospacedSystemFont(ofSize: fontPoints, weight: .regular)
        if tv.font != f { tv.font = f }
    }
}
