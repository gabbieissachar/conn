// The compose box: the one place Helm can write to a pane. Off unless the session is on the write allow list, with a
// short undo window before anything is sent, and the text comes back into the box if delivery fails.
import SwiftUI
import HelmCore

struct HeldBanner: View {
    @EnvironmentObject var app: AppModel
    let h: HeldMessage

    var body: some View {
        HStack(spacing: 8) {
            switch h.phase {
            case .held: Image(systemName: "hourglass"); Text("Sending to \(h.agentName) in \(h.secondsLeft)s.")
            case .sending: ProgressView().controlSize(.small); Text("Sending to \(h.agentName)…")
            case .sent: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green); Text("Sent to \(h.agentName).")
            case .undone: Image(systemName: "arrow.uturn.backward"); Text("Taken back into the box.")
            case .failed(let why): Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange); Text("Not sent: \(why). Your text is back in the box.").lineLimit(2)
            }
            Spacer()
            if h.phase == .held { Button("Undo") { app.undoHeld() }.buttonStyle(.borderless).keyboardShortcut("z", modifiers: .command) }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .transition(.opacity)
    }
}

struct ComposeBar: View {
    @EnvironmentObject var app: AppModel
    @State private var confirmEnable = false

    var body: some View {
        VStack(spacing: 8) {
            if let h = app.held { HeldBanner(h: h) }
            if let a = app.selectedAgent {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text("To \(a.name) · \(a.state.label)").font(.system(size: 11)).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                            .redacted(reason: app.privacy ? .placeholder : [])
                        Spacer(minLength: 8)
                        if app.writesEnabled {
                            Button("Turn off sending") { app.disableWrites() }.buttonStyle(.link).font(.system(size: 11))
                        } else {
                            Label("Sending to \(app.endpoint.session) is off", systemImage: "lock.fill").font(.system(size: 11, weight: .medium)).foregroundStyle(Color.orange)
                            Button("Turn on…") { confirmEnable = true }.buttonStyle(.link).font(.system(size: 11))
                        }
                    }
                    if app.writesEnabled, let why = app.composeProblem {
                        Label(why, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Color.orange)
                    }
                    HStack(alignment: .bottom, spacing: 8) {
                        TextField(app.privacy ? "Message" : "Message \(a.name)", text: $app.compose, axis: .vertical)
                            .textFieldStyle(.plain).lineLimit(1...5).font(.system(size: 13))
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.primary.opacity(0.10)))
                            .disabled(!app.writesEnabled)
                            .opacity(app.writesEnabled ? 1 : 0.55)
                        Button("Send") { app.send() }
                            .fixedSize()
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(app.composeText.isEmpty || !app.writesEnabled || app.composeProblem != nil)
                            .help("⌘↩ sends the text and Enter to this agent after a short undo window")
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(.bar)
        .confirmationDialog("Let Helm send text to session \(app.endpoint.session)?", isPresented: $confirmEnable, titleVisibility: .visible) {
            Button("Turn on sending", role: .destructive) { app.enableWrites() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The compose box will type your text and press Enter in the selected agent's pane. Agents act on what they receive. Panes stay observe-only; this affects the compose box only, and only for this session.")
        }
    }
}
