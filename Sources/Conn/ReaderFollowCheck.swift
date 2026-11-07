// `--ui-check` step for "the reader never shows another agent's transcript for the row that was clicked" (fixture only: it adds a
// pane to the stand-in Herdr, which has no session for it, as a freshly started worker looks to real Herdr).
//
// What a person meets: they click an agent row and the Reader column opens that agent's conversation. Three things went wrong:
//   - a pane Herdr names no session for (a worker started a moment ago: Herdr omits `agent_session` until an integration reports one)
//     pinned nothing, so the column stayed on the agent chosen before and read as this agent's transcript;
//   - with the Herdr client driving (a person's own launch) a sidebar click moved the client and the highlight but never pinned the reader;
//   - once Herdr did report the session, nothing pinned it.
// The reader's own fallback for a session it does not list yet is the reader's (README "Pinning the reader").
import SwiftUI
import ConnCore

@MainActor
enum ReaderFollowCheck {
    /// One call to the stand-in's test controls (`fake.*`). Only ever the stand-in: a real session is refused by the caller.
    private static func fake(_ model: AppModel, _ method: String, _ params: [String: Any]) -> Bool {
        guard let sock = UnixLineSocket(path: model.endpoint.socketPath) else { return false }
        defer { sock.close() }
        guard sock.writeLine(["id": "check", "method": method, "params": params]), let reply = sock.readJSON(timeout: 5) else { return false }
        return reply["error"] == nil
    }

    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture, model.endpoint.isStandIn else {
            print("ui-check: SKIP the reader follows the clicked row (needs the stand-in Herdr: it adds a pane that has no session yet)")
            return
        }
        model.showWeb = true; model.webTab = .reader; model.readerFollows = true; model.watchOn = false
        if let w = Capture.mainWindow() { w.setContentSize(NSSize(width: 1500, height: 900)) }
        await wait(1.5)
        let reader = model.web.box(.reader)
        func fragment() async -> String {
            var n = 0
            while reader.phase != .ready && n < 40 { await wait(0.2); n += 1 }
            await wait(0.8)
            return reader.webView.url?.fragment ?? ""
        }
        func until(_ timeout: Double, _ done: () -> Bool) async { var t = 0.0; while !done() && t < timeout { await wait(0.1); t += 0.1 } }
        let shotDir = ProcessInfo.processInfo.environment["CONN_UI_CHECK_SHOT_DIR"]

        // 1. Each row opens its own conversation (the row-to-session mapping; nothing about the row on screen or the one before).
        let plain = model.snapshot.prioritized.filter { model.ask(for: $0) == nil && $0.sessionID != nil }
        let picks = stride(from: 0, to: plain.count, by: max(1, plain.count / 6)).map { plain[$0] }.prefix(6)
        var wrong: [String] = []
        for a in picks {
            model.sidebarOpenAgent(a)
            let f = await fragment()
            if f != "s=\(a.sessionID ?? "-")" { wrong.append("\(a.id): \(f)") }
        }
        report("each agent row opens its own conversation in the reader (\(picks.count) rows, one after the other)", !picks.isEmpty && wrong.isEmpty, "wrong=\(wrong)")
        guard let before = picks.last, let beforeSession = before.sessionID else { report("a row with a session exists", false, ""); return }

        // 2. A pane Herdr names no session for says so, and the column does not stay on the agent chosen before.
        let freshID = "w98:p1"
        let added = fake(model, "fake.add_pane", ["pane_id": freshID, "label": "fresh scout", "state": "working"])
        await until(6) { model.snapshot.agent(freshID) != nil }
        guard added, let fresh = model.snapshot.agent(freshID) else { report("the stand-in adds a pane with no session", false, "added=\(added)"); return }
        report("the new pane has no session in Herdr's snapshot (the field is omitted, as real Herdr does until an integration reports one)", fresh.sessionID == nil, "session=\(fresh.sessionID ?? "nil")")
        let pinsBefore = reader.pinsInPlace + reader.pinsLoaded
        model.sidebarOpenAgent(fresh)
        await wait(1.2)
        report("a click on a row with no session selects it and the Reader column says 'no transcript yet' instead of keeping the agent chosen before",
               model.selectedPaneID == freshID && model.readerHasNoTranscript, "selected=\(model.selectedPaneID ?? "-") noTranscript=\(model.readerHasNoTranscript)")
        report("... and Conn pins nothing for it (the page underneath is not sent anywhere)", reader.pinsInPlace + reader.pinsLoaded == pinsBefore && reader.shownSession.map { beforeSession.hasPrefix($0) } == true,
               "pins=\(reader.pinsInPlace + reader.pinsLoaded) was=\(pinsBefore) shown=\(reader.shownSession ?? "-")")
        if let dir = shotDir { await Capture.window(to: URL(fileURLWithPath: dir).appendingPathComponent("reader-no-transcript.png"), webSnapshots: false) }
        model.sidebarOpenAgent(before)
        await wait(0.8)
        report("choosing an agent with a session clears the notice and opens its conversation", !model.readerHasNoTranscript && model.selectedPaneID == before.id && reader.shownSession.map { beforeSession.hasPrefix($0) } == true,
               "noTranscript=\(model.readerHasNoTranscript) shown=\(reader.shownSession ?? "-")")

        // 3. Herdr reports the session later: the reader opens it without another click.
        model.sidebarOpenAgent(fresh)
        await wait(0.8)
        let late = "00000000-0000-4000-8000-000000000005"
        let reported = fake(model, "fake.set_session", ["pane_id": freshID, "session": late])
        await until(6) { model.snapshot.agent(freshID)?.sessionID == late }
        let lateFragment = await fragment()
        report("when Herdr reports the session the notice goes and the reader opens it on its own", reported && !model.readerHasNoTranscript && lateFragment == "s=\(late)",
               "reported=\(reported) noTranscript=\(model.readerHasNoTranscript) fragment=\(lateFragment)")

        // 4. The Herdr client driving (a person's own launch): a sidebar click moves the client and also moves the reader. The client
        // here is the stand-in's screen. It never moves Herdr's focus pointer, so the move is not confirmed and the highlight goes back.
        model.sidebarOpenAgent(before)
        _ = await fragment()
        let savedMode = model.mode, savedHide = model.hideHerdrSidebar
        model.hideHerdrSidebar = false          // the client reads Herdr's own config; no file is written
        model.mode = .herdr
        model.attachHerdrClient()
        await until(8) { model.fallback.running }
        await wait(1.0)      // the client has attached: the sidebar adopts the place it opened on
        if model.herdrClientDriving, let from = model.selectedPaneID, let fromSession = model.snapshot.agent(from)?.sessionID,
           let target = plain.first(where: { !$0.workspaceID.hasPrefix("w01") && $0.id != from }), let targetSession = target.sessionID {
            model.sidebarOpenAgent(target)
            if model.selectedPaneID == target.id {
                let f = await fragment()
                report("with the Herdr client driving, a sidebar click moves the reader to that agent too", f == "s=\(targetSession)" && !model.readerHasNoTranscript, "fragment=\(f) want=s=\(targetSession)")
                await until(8) { model.selectedPaneID == from }
                let back = await fragment()
                report("... and when the client does not confirm the move the highlight goes back and the reader goes with it", model.selectedPaneID == from && back == "s=\(fromSession)", "selected=\(model.selectedPaneID ?? "-") fragment=\(back) want=s=\(fromSession)")
            } else {
                print("ui-check: SKIP the client-driving click (the client's key map was not available, so the click selected nothing)")
            }
        } else {
            print("ui-check: SKIP the client-driving click (the stand-in client did not start)")
        }
        model.fallback.stop()
        model.mode = savedMode; model.hideHerdrSidebar = savedHide
        await wait(0.5)
    }
}
