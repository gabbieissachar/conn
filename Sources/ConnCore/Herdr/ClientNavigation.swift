// Moving the embedded Herdr client from Conn's sidebar, one client only.
//
// Herdr's socket focus commands (`workspace focus`, `tab focus`) are session-wide: they move every attached client, including
// the ones on the person's other screens. Keys typed into one client's pty move only that client. So a sidebar click becomes
// a short key sequence typed into the embedded client's pty, worked out from the live workspace and tab order in a Herdr
// snapshot and from the client's own key bindings (HerdrClientKeymap). Nothing here calls a focus command.
//
// Herdr 0.9.5 reaches workspace and tab positions 1...9 with one key sequence each. Past 9 there is no direct key, so the
// plan goes to 9 first, confirms the client is there, then steps on from 9 (Down in workspace navigation, next tab for tabs).
// Starting at 9 makes the steps independent of where the client was, so no position of the client has to be known.
//
// Every stage ends with a check. Herdr keeps one session-wide pointer to the workspace and tab last selected by any client
// (`focused_workspace_id`, `focused_tab_id` in the snapshot), and a client selecting something moves it even when it was
// already there. After typing a stage the pointer must read the stage's target: if it does not within a short time the client
// did not move (it was in a dialog or copy mode, or has a binding Conn did not read), the remaining stages are not typed, and
// the failure is reported. Nothing is retried on its own: a second try would type the same keys into the same state.
import Foundation

public enum HerdrClientNavigation {
    /// Where the client should end up.
    public enum Target: Equatable, Sendable {
        case workspace(String)
        /// A tab, by its id: the plan first moves to the tab's workspace.
        case tab(String)
    }

    /// What the session's focus pointer must read once a stage's keys have been typed.
    public enum Expectation: Equatable, Sendable {
        case workspace(String)
        case tab(String)
    }

    public struct Stage: Equatable, Sendable {
        /// Typed into the client's pty in this order, one chunk at a time with a short pause between.
        public var chunks: [[UInt8]]
        public var expect: Expectation
        public init(chunks: [[UInt8]], expect: Expectation) { self.chunks = chunks; self.expect = expect }
    }

    public enum PlanFailure: Error, Equatable, CustomStringConvertible {
        case unknownWorkspace(String)
        case unknownTab(String)

        public var description: String {
            switch self {
            case .unknownWorkspace(let id): return "Workspace \(id) is not in Herdr's current list."
            case .unknownTab(let id): return "Tab \(id) is not in Herdr's current list."
            }
        }
    }

    /// Workspaces in the order Herdr numbers them (digit keys and the navigation list follow this order).
    static func ordered(_ snapshot: Snapshot) -> [Workspace] {
        snapshot.workspaces.enumerated().sorted { ($0.element.number, $0.offset) < ($1.element.number, $1.offset) }.map(\.element)
    }

    static func ordered(tabs: [HerdrTab]) -> [HerdrTab] {
        tabs.enumerated().sorted { ($0.element.number, $0.offset) < ($1.element.number, $1.offset) }.map(\.element)
    }

    static func digit(_ n: Int) -> [UInt8] { [UInt8(0x30 + n)] }

    public static func plan(to target: Target, in snapshot: Snapshot, keymap: HerdrClientKeymap) throws -> [Stage] {
        switch target {
        case .workspace(let id):
            return try workspaceStages(id, in: snapshot, keymap: keymap)
        case .tab(let id):
            guard let tab = snapshot.tabs.first(where: { $0.id == id }) else { throw PlanFailure.unknownTab(id) }
            let tabs = ordered(tabs: snapshot.tabs(in: tab.workspaceID))
            guard let index = tabs.firstIndex(where: { $0.id == id }) else { throw PlanFailure.unknownTab(id) }
            var stages = try workspaceStages(tab.workspaceID, in: snapshot, keymap: keymap)
            let position = index + 1
            let jump = keymap.prefix + digit(min(position, 9))
            if position <= 9 {
                stages.append(Stage(chunks: [jump], expect: .tab(id)))
            } else {
                // Tab 9 first (it exists whenever a tab 10 does), then one step on per tab past it.
                stages.append(Stage(chunks: [jump], expect: .tab(tabs[8].id)))
                stages.append(Stage(chunks: Array(repeating: keymap.prefix + keymap.nextTab, count: position - 9), expect: .tab(id)))
            }
            return stages
        }
    }

    private static func workspaceStages(_ id: String, in snapshot: Snapshot, keymap: HerdrClientKeymap) throws -> [Stage] {
        let list = ordered(snapshot)
        guard let index = list.firstIndex(where: { $0.id == id }) else { throw PlanFailure.unknownWorkspace(id) }
        let position = index + 1
        let open = keymap.prefix + keymap.workspacePicker
        if position <= 9 { return [Stage(chunks: [open + digit(position)], expect: .workspace(id))] }
        // Navigation closes after a digit, so it is opened again at workspace 9 and moved down from there.
        let down = Array(repeating: keymap.navigateDown, count: position - 9).flatMap { $0 }
        return [Stage(chunks: [open + digit(9)], expect: .workspace(list[8].id)),
                Stage(chunks: [open, down, HerdrClientKeymap.enter], expect: .workspace(id))]
    }
}

/// Types a plan into the client and confirms each stage against the session's focus pointer.
public final class HerdrClientNavigator: @unchecked Sendable {
    public enum Outcome: Equatable, Sendable {
        case landed
        /// The client did not confirm. `stage` counts from 1; nothing after it was typed.
        case failed(stage: Int, of: Int, reason: String)
    }

    /// The workspace and tab Herdr reports as focused, or nil when it could not be read.
    public struct Focus: Equatable, Sendable {
        public var workspaceID: String?
        public var tabID: String?
        public init(workspaceID: String?, tabID: String?) { self.workspaceID = workspaceID; self.tabID = tabID }
    }

    public var confirmTimeout: TimeInterval = 2.5
    public var pollInterval: TimeInterval = 0.08
    /// Pause after each typed chunk: Herdr reads a prefix and its action key as two steps.
    public var chunkPause: TimeInterval = 0.05

    private let send: @Sendable ([UInt8]) async -> Void
    private let readFocus: @Sendable () async -> Focus?

    /// `send` types bytes into the client's pty; `readFocus` reads the session's focus pointer (a fresh snapshot).
    public init(send: @escaping @Sendable ([UInt8]) async -> Void, readFocus: @escaping @Sendable () async -> Focus?) {
        self.send = send
        self.readFocus = readFocus
    }

    public func run(_ stages: [HerdrClientNavigation.Stage]) async -> Outcome {
        for (i, stage) in stages.enumerated() {
            if Task.isCancelled { return .failed(stage: i + 1, of: stages.count, reason: "cancelled") }
            for chunk in stage.chunks {
                await send(chunk)
                try? await Task.sleep(nanoseconds: UInt64(chunkPause * 1_000_000_000))
            }
            if let reason = await confirm(stage.expect) { return .failed(stage: i + 1, of: stages.count, reason: reason) }
        }
        return .landed
    }

    /// nil when the focus pointer reads the expectation within the timeout, else why not.
    private func confirm(_ expect: HerdrClientNavigation.Expectation) async -> String? {
        let deadline = Date().addingTimeInterval(confirmTimeout)
        var last: Focus?
        repeat {
            if Task.isCancelled { return "cancelled" }
            if let f = await readFocus() {
                last = f
                switch expect {
                case .workspace(let id): if f.workspaceID == id { return nil }
                case .tab(let id): if f.tabID == id { return nil }
                }
            }
            try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        } while Date() < deadline
        guard let last = last else { return "Herdr's position could not be read" }
        return "Herdr still reported workspace \(last.workspaceID ?? "none"), tab \(last.tabID ?? "none")"
    }
}

/// Decides when the sidebar follows Herdr's focus pointer while the embedded client runs. The pointer is one per session (the
/// place last selected by any attached client), so a change in it is only taken as the embedded client's own when the person
/// has just typed or clicked in that client; a change made on another screen is left alone.
public struct HerdrClientFocusFollower: Equatable, Sendable {
    public private(set) var last: String?
    public init() {}

    /// Forget the last position, as when the client ends.
    public mutating func reset() { last = nil }

    /// The workspace and tab to show in the sidebar, or nil to leave it. Only a change is looked at, and a change that is
    /// not followed is still remembered, so typing later never applies an old change. `adopt` follows the pointer as it is
    /// (a new client opens there). `settled` is false while the sidebar's own sequence is still moving the pointer.
    public mutating func observe(workspace: String?, tab: String?, adopt: Bool = false, settled: Bool, userActive: Bool) -> (workspace: String, tab: String)? {
        guard let ws = workspace, let tab = tab else { return nil }
        let key = "\(ws)/\(tab)"
        if key == last && !adopt { return nil }
        last = key
        guard adopt || (settled && userActive) else { return nil }
        return (ws, tab)
    }
}
