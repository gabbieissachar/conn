// Which agents sit at a Claude permission prompt that Herdr did not call blocked (see ConnCore/PermissionPrompt.swift for why).
//
// Every few seconds, only while the window is on screen and the app is in use, Conn reads the visible text of each Claude pane that
// Herdr says is working or idle (`pane.read`, plain text: one small read per pane, no stream) and asks `ClaudePermissionPrompt`
// whether the bottom of the screen is a permission prompt. A pane that is shows as needing you (the orange glyph, the Dock badge, the
// header count, the menu-bar list) until the screen stops showing it, one beat after the answer. Reads happen off the main thread, one
// beat at a time. Panes Herdr already calls blocked, done or unknown are not read. Nothing is sent to any pane.
import SwiftUI
import ConnCore

@MainActor
final class PermissionPromptWatch: ObservableObject {
    /// The panes whose screen shows a permission prompt now.
    @Published private(set) var panes: Set<String> = []

    /// One question about a pane's screen: its text, or nil when it cannot be read.
    typealias Reader = @Sendable (String) -> String?
    private let reader: Reader
    private var timer: Timer?
    private var inFlight = false
    private(set) var beats = 0
    private(set) var readsInLastBeat = 0
    /// At most this many panes are read in one beat.
    static let maxReadsPerBeat = 48

    init(reader: @escaping Reader) { self.reader = reader }

    convenience init(client: HerdrClient) {
        client.timeout = 3
        self.init(reader: { pane in try? client.readPane(pane, source: .visible, ansi: false) })
    }

    /// Candidates are the Claude agents Herdr reports as working or idle.
    static func candidates(in snapshot: Snapshot) -> [String] {
        snapshot.agents.filter { $0.harness == "claude" && ($0.state == .working || $0.state == .idle) }.map(\.id)
    }

    func start(interval: TimeInterval = 5, snapshot: @escaping @MainActor () -> Snapshot, active: @escaping @MainActor () -> Bool) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if let self = self, active() { self.refresh(snapshot()) } }
        }
    }

    func stop() { timer?.invalidate(); timer = nil }

    /// One beat: read the candidates' screens in the background, then take the answer.
    func refresh(_ snapshot: Snapshot) {
        guard !inFlight else { return }
        let ids = Array(Self.candidates(in: snapshot).prefix(Self.maxReadsPerBeat))
        inFlight = true
        let read = reader
        Task { [weak self] in
            let found = await Task.detached(priority: .utility) { () -> Set<String> in
                var out = Set<String>()
                for id in ids { if let text = read(id), ClaudePermissionPrompt.isShowing(in: text) { out.insert(id) } }
                return out
            }.value
            guard let self = self else { return }
            self.inFlight = false
            self.beats += 1
            self.readsInLastBeat = ids.count
            if found != self.panes { self.panes = found }
        }
    }

    /// For a check: forget what was found.
    func reset() { panes = [] }
}
