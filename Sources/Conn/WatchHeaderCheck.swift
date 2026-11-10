// `--ui-check` steps for the Watch column header's agent state (README "Watch view", "The header names the agent"). A column can hold an older session id of a conversation than the one
// Herdr names now (a setup remembered from before a `/clear`, a star, a link). The fixture's glance feed lists a chain of two ids for the first six agents, and the check puts the OLDER id
// of the first N agents in N columns, for 2, 3 and 4 columns, and asks what each header would say: the agent's real state, not "no agent".
import SwiftUI
import ConnCore

@MainActor
enum WatchHeaderCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture else { print("ui-check: SKIP Watch header state (the fixture's glance feed carries the chains; run with --fixture)"); return }
        let saved = (mode: model.mode, web: model.showWeb, tab: model.webTab, watch: model.watchOn)
        defer { model.watchOn = saved.watch; model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab }
        func shot(_ name: String) async {
            if let d = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"] { await Capture.window(to: URL(fileURLWithPath: d).appendingPathComponent(name), webSnapshots: false) }
        }
        // Agents whose session id the fixture's glance feed gives an older id for.
        let pairs: [(agent: Agent, older: String)] = model.snapshot.agents.compactMap { a in
            guard let sid = a.sessionID, sid.hasPrefix("00000000-0000-4000-8000-"), let n = Int(sid.suffix(12)), (1...6).contains(n) else { return nil }
            return (a, "0a1d0000-0000-4000-8000-" + sid.suffix(12))
        }.sorted { ($0.agent.sessionID ?? "") < ($1.agent.sessionID ?? "") }
        guard pairs.count >= 4 else { report("the fixture has four agents with a chain in the glance feed", false, "pairs=\(pairs.count)"); return }
        report("the glance feed is read: the older id of a conversation is the same conversation as the id Herdr names, and a stranger is not",
               model.stars.chains.same(pairs[0].older, pairs[0].agent.sessionID ?? "") && !model.stars.chains.same(pairs[0].older, pairs[1].agent.sessionID ?? "") && model.stars.chains.count >= 4,
               "chains=\(model.stars.chains.count)")

        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watchOn = true
        await wait(1.0)
        for n in [2, 3, 4] {
            _ = model.watch.apply(WatchSetup(columns: pairs.prefix(n).map { $0.older }))
            await wait(1.5)
            let states = pairs.prefix(n).map { model.agent(forSession: $0.older)?.state }
            let wanted = pairs.prefix(n).map { $0.agent.state }
            let names = pairs.prefix(n).map { model.watchColumnLabel($0.older) }
            report("with \(n) columns holding an older id of each conversation, every header resolves its agent and shows its real state (not \"no agent\")",
                   model.watch.layout.count == n && states.allSatisfy { $0 != nil } && states.compactMap { $0 } == wanted && names == pairs.prefix(n).map { $0.agent.name },
                   "columns=\(model.watch.layout.count) states=\(states.map { $0?.label ?? "none" }) wanted=\(wanted.map(\.label)) names=\(names)")
            await shot("watch-header-\(n)-columns.png")
        }
        // A session nobody runs, and one with no chain, still has no agent: the match did not become looser.
        let stranger = "0a1d0000-0000-4000-8000-0000000000ff"
        report("a session no agent runs and the feed does not chain still shows no agent", model.agent(forSession: stranger) == nil, "agent=\(model.agent(forSession: stranger)?.name ?? "nil")")
        // The state feed that raises a hidden column's cue reads the same.
        let a = pairs[0]
        report("the hidden column's cue reads the same state for an older id", model.watch.stateOf(a.older) == a.agent.state, "state=\(model.watch.stateOf(a.older)?.label ?? "nil")")
    }
}
