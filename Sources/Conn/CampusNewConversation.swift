// "New conversation" in Campus (README "Campus in Conn", Writes): the sheet that takes the first message and starts it through the write gate.
// Same rules as every Campus write: the "Campus writes" switch, a 3-second Undo, one write at a time. The text never leaves the box until Campus answers, so
// an Undo or a failure leaves it exactly where it was; when Campus answers the sheet closes and the new conversation opens in the centre.
import SwiftUI
import ConnCore

struct CampusNewConversationSheet: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore
    let space: CampusSpace
    @State private var text = ""
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var phase: CampusHeld.Phase? { campus.held?.conversationID == CampusStore.startKey(space) ? campus.held?.phase : nil }
    /// A start is waiting or going out: the box is locked and Start is not offered again.
    private var busy: Bool { phase == .held || phase == .sending }
    private var on: Bool { campus.writesEnabled && campus.link == .live }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("New conversation").font(.system(size: 14, weight: .semibold))
            Text(space.isTeam ? "In the team space \(space.displayName)" : "In \(space.displayName)").font(.system(size: 12)).foregroundStyle(.secondary)
                .redacted(reason: app.privacy && space.isTeam ? .placeholder : [])
            CampusHeldBanner(campus: campus).padding(.horizontal, -12).padding(.top, -8)
            TextEditor(text: $text)
                .font(.system(size: 13)).scrollContentBackground(.hidden).focused($focused)
                .padding(6).frame(minHeight: 120)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.primary.opacity(0.10)))
                .disabled(busy).opacity(busy ? 0.55 : 1)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty { Text("The first message. Campus starts working on it as soon as it is sent.").font(.system(size: 13)).foregroundStyle(.tertiary).padding(.horizontal, 11).padding(.vertical, 14).allowsHitTesting(false) }
                }
                .accessibilityIdentifier("campus-new-input")
            if !campus.writesEnabled { Label("Campus writes are off", systemImage: "lock.fill").font(.system(size: 11, weight: .medium)).foregroundStyle(Color.orange) }
            else if campus.link != .live { Label("Campus is not reachable: sign in first", systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Color.orange) }
            HStack {
                Text("Sent after a 3-second Undo.").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { app.closeCampusNew() }.keyboardShortcut(.cancelAction).disabled(phase == .sending).accessibilityIdentifier("campus-new-cancel")
                Button("Start") { app.startCampusConversation(trimmed, in: space) }
                    .keyboardShortcut(.return, modifiers: .command).buttonStyle(.borderedProminent)
                    .disabled(!on || trimmed.isEmpty || busy).help(on ? "\u{2318}\u{21A9} starts after a short undo window" : "Campus writes are off")
                    .accessibilityIdentifier("campus-new-start")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(width: 460)
        .onAppear { focused = true }
        .accessibilityElement(children: .contain).accessibilityIdentifier("campus-new-sheet")
    }
}

/// The Campus menu's "New Conversation in ..." items: one for My space and one for each team space, so a space is never more than one menu away.
struct CampusNewMenuItems: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var campus: CampusStore

    var body: some View {
        let spaces = app.campusStartSpaces
        ForEach(spaces) { s in
            Button(s.isTeam ? "New Conversation in \(s.displayName)\u{2026}" : "New Conversation in My Space\u{2026}") { app.newCampusConversation(in: s) }
        }
        if spaces.isEmpty { Button("New Conversation\u{2026}") {}.disabled(true) }
    }
}
