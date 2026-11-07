// `--ui-check` step for an agent sitting at a Claude permission prompt that Herdr does not report as blocked (fixture only: the
// stand-in's `fake.set_screen` puts the prompt on a working pane and leaves Herdr's own state alone, which is what the captain met).
// First the other half of the question: when Herdr does say blocked, Conn shows it at once (glyph, header count, Dock badge, order).
import SwiftUI
import ConnCore

@MainActor
enum PermissionPromptCheck {
    private static func fake(_ model: AppModel, _ method: String, _ params: [String: Any]) -> Bool {
        guard let sock = UnixLineSocket(path: model.endpoint.socketPath) else { return false }
        defer { sock.close() }
        guard sock.writeLine(["id": "check", "method": method, "params": params]), let reply = sock.readJSON(timeout: 5) else { return false }
        return reply["error"] == nil
    }

    static let prompt = [
        "● Fetching the how-to page now.", "",
        "╭──────────────────────────────────────────────────────────────╮",
        "│ Fetch                                                        │", "│",
        "│   https://example.invalid/guides/whatsapp                    │",
        "│   Claude wants to fetch content from example.invalid         │", "│",
        "│ Do you want to allow Claude to fetch this content?           │",
        "│ ❯ 1. Yes                                                     │",
        "│   2. Yes, and don't ask again for example.invalid            │",
        "│   3. No, and tell Claude what to do differently (esc)        │",
        "╰──────────────────────────────────────────────────────────────╯",
    ]

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, model.endpoint.isStandIn else {
            print("ui-check: SKIP permission prompts (needs the stand-in Herdr: it shows a prompt on a pane without changing Herdr's state)")
            return
        }
        func until(_ timeout: Double, _ done: () -> Bool) async { var t = 0.0; while !done() && t < timeout { await wait(0.1); t += 0.1 } }
        func settle(_ pane: String, _ state: AgentState) async { await until(6) { model.store.snapshot.agent(pane)?.state == state } }
        func beat() async {
            let before = model.promptWatch.beats
            model.promptWatch.refresh(model.store.snapshot)
            await until(6) { model.promptWatch.beats > before }
        }
        func badge() -> Int { Int(NSApp.dockTile.badgeLabel ?? "") ?? 0 }
        model.promptWatch.reset()
        model.openAsks.clearRead()
        await wait(0.5)
        guard let working = model.store.snapshot.agents.first(where: { $0.harness == "claude" && $0.state == .working }),
              let idle = model.store.snapshot.agents.first(where: { $0.harness == "claude" && $0.state == .idle && $0.id != working.id }) else { report("a working and an idle fixture agent exist", false, ""); return }
        let waitingBefore = model.waiting.count

        // 0. Herdr says blocked: Conn shows it (so the captain's miss was not Conn ignoring a blocked state).
        _ = fake(model, "fake.set_state", ["pane_id": idle.id, "state": "blocked"])
        await settle(idle.id, .blocked)
        await wait(0.3)
        report("when Herdr reports blocked, Conn shows it: needs-you state, counted, first in the list, in the Dock badge",
               model.snapshot.agent(idle.id)?.state == .blocked && model.waiting.contains { $0.id == idle.id } && model.agentOrder.first { $0.id == idle.id } != nil && badge() == waitingBefore + 1,
               "state=\(model.snapshot.agent(idle.id)?.state.label ?? "-") waiting=\(model.waiting.count) was=\(waitingBefore) badge=\(badge())")
        _ = fake(model, "fake.set_state", ["pane_id": idle.id, "state": "idle"])
        await settle(idle.id, .idle)

        // 1. A working agent at a permission prompt, Herdr still saying working.
        await wait(0.3)
        let base = (waiting: model.waiting.count, needYou: model.needYouCount, badge: badge())
        _ = fake(model, "fake.set_screen", ["pane_id": working.id, "lines": prompt])
        await beat()
        report("a Claude pane whose screen is a permission prompt shows as needing you although Herdr still says working",
               model.store.snapshot.agent(working.id)?.state == .working && model.snapshot.agent(working.id)?.state == .blocked && model.promptWatch.panes == [working.id],
               "herdr=\(model.store.snapshot.agent(working.id)?.state.label ?? "-") conn=\(model.snapshot.agent(working.id)?.state.label ?? "-") panes=\(model.promptWatch.panes)")
        await wait(0.4)
        report("... counted like any blocked agent: the list, the header count and the Dock badge all go up by one",
               model.waiting.count == base.waiting + 1 && model.needYouCount == base.needYou + 1 && badge() == base.badge + 1 && model.agentOrder.prefix(model.needYouCount).contains { $0.id == working.id },
               "waiting=\(model.waiting.count) needYou=\(model.needYouCount) badge=\(badge()) (was \(base.waiting)/\(base.needYou)/\(base.badge))")
        let ws = model.snapshot.workspace(working.workspaceID)
        report("... and its space rolls up as needing you", ws?.state == .blocked, "space=\(ws?.state.label ?? "-")")
        if let dir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("permission-prompt.png"), webSnapshots: false) }

        // 2. An idle one too; a pane that only talks about a prompt does not count; panes Herdr calls done are not read.
        _ = fake(model, "fake.set_screen", ["pane_id": idle.id, "lines": prompt])
        let talk = model.store.snapshot.agents.first { $0.harness == "claude" && $0.state == .idle && $0.id != idle.id && $0.id != working.id }
        if let talk = talk {
            _ = fake(model, "fake.set_screen", ["pane_id": talk.id, "lines": ["● You asked what the prompt says. It reads:", "  Do you want to allow Claude to fetch this content?", "  1. Yes", "  3. No", "● That is all it says."]])
        }
        await beat()
        report("an idle Claude agent at a prompt shows too, and one whose screen only quotes a prompt does not", model.promptWatch.panes == [working.id, idle.id] && talk.map { !model.promptWatch.panes.contains($0.id) } == true,
               "panes=\(model.promptWatch.panes.sorted())")
        let candidates = PermissionPromptWatch.candidates(in: model.store.snapshot)
        report("only Claude agents Herdr calls working or idle are read (one read each per beat)", model.promptWatch.readsInLastBeat == candidates.count && !candidates.isEmpty && candidates.allSatisfy { id in model.store.snapshot.agent(id).map { $0.state == .working || $0.state == .idle } == true },
               "reads=\(model.promptWatch.readsInLastBeat) candidates=\(candidates.count) agents=\(model.store.snapshot.agents.count)")

        // 3. The prompt is answered: the screen changes and the next beat takes the mark away.
        _ = fake(model, "fake.set_screen", ["pane_id": working.id, "lines": ["● Fetched. The page lists three steps.", "", "╭──────────╮", "│ >        │", "╰──────────╯", "  ? for shortcuts"]])
        _ = fake(model, "fake.set_screen", ["pane_id": idle.id, "lines": ["● Back to work."]])
        await beat()
        await wait(0.4)
        report("once the prompt is gone from the screen the mark goes and the counts return", model.promptWatch.panes.isEmpty && model.snapshot.agent(working.id)?.state == .working && model.waiting.count == base.waiting && badge() == base.badge,
               "panes=\(model.promptWatch.panes) waiting=\(model.waiting.count) badge=\(badge())")

        // 4. A pane Herdr itself calls blocked is left alone, and the mark follows the state Herdr reports.
        _ = fake(model, "fake.set_screen", ["pane_id": working.id, "lines": prompt])
        _ = fake(model, "fake.set_state", ["pane_id": working.id, "state": "done"])
        await settle(working.id, .done)
        await beat()
        report("a pane Herdr calls done is not read, so Herdr's own state stands", !model.promptWatch.panes.contains(working.id) && model.snapshot.agent(working.id)?.state == .done, "panes=\(model.promptWatch.panes)")
        _ = fake(model, "fake.set_state", ["pane_id": working.id, "state": "working"])
        await settle(working.id, .working)
        // Leave the stand-in as found: both panes print again (a frozen working pane sends no frames to a stream that opens on it).
        _ = fake(model, "fake.set_screen", ["pane_id": working.id, "lines": ["● ok"], "freeze": false])
        _ = fake(model, "fake.set_screen", ["pane_id": idle.id, "lines": ["● ok"], "freeze": false])
        if let talk = talk { _ = fake(model, "fake.set_screen", ["pane_id": talk.id, "lines": ["● ok"], "freeze": false]) }
        await beat()
        model.promptWatch.reset()
    }
}
