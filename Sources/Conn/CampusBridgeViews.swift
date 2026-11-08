// The agent bridge in the window (S2): the status-bar switch, the confirmation, the activity sheet, the settings section, and "Share with Agents" on a Campus row.
// The engine is `BridgeEngine` (ConnCore); this file only shows it and flips its switch. Decisions: README "The agent bridge".
import SwiftUI
import ConnCore

/// "Agent bridge: off" / "Agent bridge: on · N today" in the status bar. A click turns it off at once, or asks before it goes on.
struct BridgeStatusItem: View {
    @EnvironmentObject var app: AppModel

    var body: some View {
        if let b = app.campusBridge { Inner(bridge: b) }
    }

    private struct Inner: View {
        @EnvironmentObject var app: AppModel
        @ObservedObject var bridge: BridgeEngine
        var body: some View {
            Button { if bridge.enabled { app.disableCampusBridge() } else { app.requestCampusBridge() } } label: {
                Text(bridge.enabled ? "Agent bridge: on · \(bridge.last24h) today" : "Agent bridge: off")
                    .foregroundStyle(bridge.enabled ? Color.orange : Color.secondary)
            }
            .buttonStyle(.plain)
            .help(bridge.enabled ? "Leaders can ask Campus through Conn (fm-ask campus). Click to turn it off." : "Off. Turn it on to let big-boss and the leader homes ask Campus through Conn (fm-ask campus).")
            .accessibilityIdentifier("campus-bridge-switch")
        }
    }
}

/// The requests the bridge answered, newest first: when, who asked (as claimed in the request), what, which thread, how it ended. No text of any message.
struct BridgeActivitySheet: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var bridge: BridgeEngine

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Agent bridge activity").font(.system(size: 14, weight: .semibold))
                Spacer()
                Text(bridge.enabled ? "on" : "off").font(.system(size: 11, weight: .semibold)).foregroundStyle(bridge.enabled ? Color.orange : Color.secondary)
            }
            Text("Every request is also written to an append-only audit file in Conn's folder: time, the sender as the request claimed it, request id, thread, action, size, a hash of the text and the outcome. The text itself is not kept here.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if bridge.activity.isEmpty {
                Text("Nothing since Conn started.").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 80)
            } else {
                List(bridge.activity) { a in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 8) {
                            Text(CampusTime.clock(a.at)).font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary)
                            Text(a.sender).font(.system(size: 12, weight: .semibold))
                            Text(a.action).font(.system(size: 12)).foregroundStyle(.secondary)
                            Spacer()
                            Text(a.outcome).font(.system(size: 11, weight: .semibold)).foregroundStyle(color(a.outcome))
                        }
                        if let r = a.reason { Text(r).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3) }
                        if let t = a.thread { Text("\(t) · \(a.bytes) bytes").font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.tertiary) }
                    }
                    .redacted(reason: app.privacy ? .placeholder : [])
                    .padding(.vertical, 2)
                }
                .frame(minHeight: 220)
                .accessibilityIdentifier("campus-bridge-activity")
            }
            HStack { Spacer(); Button("Done") { app.campusBridgeActivityShown = false }.keyboardShortcut(.cancelAction) }
        }
        .padding(16).frame(width: 540)
    }

    private func color(_ outcome: String) -> Color {
        switch outcome {
        case "done": return AgentState.done.color
        case "refused", "failed", "signed-out": return AgentState.blocked.color
        default: return .secondary
        }
    }
}

/// Settings (Cmd+,): the switch, who may call beyond big-boss and the leaders, and the activity.
struct BridgeSettingsSection: View {
    @EnvironmentObject var app: AppModel
    @ObservedObject var bridge: BridgeEngine
    @State private var also = ""
    @State private var loaded = false

    var body: some View {
        Section("Agent bridge") {
            Toggle("Agent bridge", isOn: Binding(get: { bridge.enabled }, set: { on in if on { app.requestCampusBridge() } else { app.disableCampusBridge() } }))
            Text("Off by default and off again at every launch. On, Conn is the session \"campus\" for fm-ask: big-boss and the leader homes can start threads in My space (titled fm/<home>: <topic>), send to them and read the replies, as you, within caps (6 new threads an hour per home, 20 a day, 3 working at once, 10 turns a thread, 8 KB in, 64 KB out). Never a worker or a personal home; never a permission answer. It is not a security boundary: any program you run can already act as you in Campus.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let why = bridge.problem { Text(why).font(.system(size: 11)).foregroundStyle(AgentState.blocked.color) }
            VStack(alignment: .leading, spacing: 3) {
                Text("Also allow these senders (one label per line, for example a captain-driven worker)").font(.system(size: 11)).foregroundStyle(.secondary)
                TextEditor(text: $also).font(.system(size: 11, design: .monospaced)).frame(height: 54)
                    .onChange(of: also) { _, v in if loaded { app.setCampusBridgeAlsoAllowed(v.split(separator: "\n").map(String.init)) } }
            }
            HStack {
                Text("\(bridge.last24h) request\(bridge.last24h == 1 ? "" : "s") in the last 24 hours")
                Spacer()
                Button("Activity…") { app.campusBridgeActivityShown = true }.accessibilityIdentifier("campus-bridge-activity-button")
            }
        }
        .onAppear { also = bridge.callers.alsoAllowed.joined(separator: "\n"); loaded = true }
    }
}

/// "Share with Agents" in a Campus row's menu: what an agent may do in this thread. A thread the bridge started is shared for good.
struct BridgeShareMenu: View {
    @EnvironmentObject var app: AppModel
    let c: CampusConversation

    var body: some View {
        if let b = app.campusBridge {
            let mode = b.ownership.mode(of: c.id)
            if mode == .owned {
                Text("Started by the agent bridge")
            } else {
                Menu("Share with Agents") {
                    Button((mode == nil ? "✓ " : "") + "Not shared") { app.shareCampus(c, nil) }
                    Button((mode == .read ? "✓ " : "") + "Read only") { app.shareCampus(c, .read) }
                    Button((mode == .readWrite ? "✓ " : "") + "Read and send") { app.shareCampus(c, .readWrite) }
                }
            }
        }
    }
}
