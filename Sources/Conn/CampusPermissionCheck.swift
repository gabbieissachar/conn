// `--campus-check`: a permission the agent asks for (a command to run), end to end on the stand-in. The stand-in's `/__fake/permission` puts a thread on a permission wait
// (the `permission.asked` event, `needs_you` in the status, the request in `GET .../form`); its `POST .../permission/<id>/reply` takes `{"decision"}`. The steps check what Conn
// shows (the row, the asks count, Cmd+J, the Watch state, the transcript item in place), the answer through the write gate, and what the transcript keeps afterwards, on the
// reader's embed page too (needs `CONN_EMBED_URL`). The first ask comes by its event; the later ones are found by the list read (`kick`), the safety net that finds an ask whose event
// never came (a stream that went quiet without closing is only noticed after 45 seconds).
import SwiftUI
import WebKit
import ConnCore

extension CampusCheck {
    static func permissionChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                                 control: (String) async -> Void, shot: (String) async -> Void) async {
        let campus = model.campus
        let base = campus.baseURL
        let id = "ses_fakeEmail05"
        func log() async -> [String] {
            guard let u = URL(string: "/__fake/log", relativeTo: base), let (d, _) = try? await URLSession.shared.data(from: u) else { return [] }
            return CampusJSON.parse(d)?["writes"].array.compactMap(\.string) ?? []
        }
        func forms() -> [CampusForm] { (campus.timeline(id)?.items ?? []).compactMap(\.form) }
        func box() -> CampusEmbedBox? { CampusEmbedBox.live.allObjects.first { $0.column == nil && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
        let embed = model.web.embedURL.map { $0.isFileURL } ?? false
        model.watchOn = false
        model.openCampus(id)
        _ = await until(10) { campus.timeline(id)?.loaded == true }
        model.enableCampusWrites()
        _ = await until(10) { campus.held == nil }

        // 1. A thread that waits on a permission needs you, with the ask on its row, counted with the questions.
        let logBefore = await log().count
        await control("/__fake/permission?c=\(id)")
        let waiting = await until(15) { campus.conversation(id)?.needsYou == true && campus.openForms[id]?.isPermission == true }
        let row = campus.conversation(id)
        report("Campus permission: a thread that waits on a permission needs you, with the ask and its tag on its row, counted with the asks (sidebar, AGENTS header, Cmd+J)",
               waiting && row?.state == .blocked && row?.ask?.text == "Allow bash: curl https://example.test" && row?.ask?.tag == "Permission · bash" && campus.asks.contains { $0.id == id } && model.waitingTargets.contains(.campus(id)),
               "needsYou=\(row?.needsYou ?? false) ask='\(row?.ask?.text ?? "-")' tag='\(row?.ask?.tag ?? "-")' targets=\(model.waitingTargets.contains(.campus(id)))")

        // 2. The Watch column's state (what its header and its cue read) is the same needs-you mark.
        let watchState = model.watch.stateOf(CampusColumn.key(id))
        report("Campus permission: a Watch column of that thread reads it as needing you (the mark its header shows and its cue follows)", watchState == .blocked && watchState?.waitsOnCaptain == true, "state=\(String(describing: watchState))")

        // 3. In the transcript, at the end, where the agent stopped: an open ask with its choices; the page leaves it to Conn's card under it.
        await wait(0.8)
        let open = campus.timeline(id)?.openForm
        report("Campus permission: the ask stands in the transcript at the end, open, with its two choices (Allow once, Reject)",
               open?.isPermission == true && campus.timeline(id)?.items.last?.kind == .form && open?.questions.first?.options == ["Allow once", "Reject"] && open?.questions.first?.text == "Allow bash: curl https://example.test",
               "items=\((campus.timeline(id)?.items ?? []).map(\.kind)) options=\(open?.questions.first?.options ?? [])")
        await shot("campus-permission-1-card.png")
        if embed, let page = box() {
            func dom(_ expr: String) async -> String { await page.read("JSON.stringify((function(){ \(expr) })())") }
            let text = await dom("return document.querySelector('#main').textContent;")
            let needs = Int(await dom("return document.querySelectorAll('.reply.needs, .asks.cform').length;")) ?? -1
            report("Campus permission: the reader's page does not draw the open ask (its choices could not be clicked there); Conn's card with the buttons sits under the page", needs == 0 && !text.contains("Allow bash"), "needs=\(needs)")
        } else { print("ui-check: SKIP Campus permission on the embed page (no CONN_EMBED_URL file)") }

        // 4. Allow once: one click, the same 3-second window as every write, then the decision goes to the permission's own route and nothing else is sent.
        let permID = campus.openForms[id]?.id ?? ""
        let held = campus.conversation(id)!
        if let f = campus.openForms[id] { model.campusPick(f, in: held, question: 0, option: "Allow once") }
        await wait(1.0)
        let inWindow = campus.held?.phase == .held && campus.held?.label == "Permission for \(held.title): Allow once"
        let early = await log().count == logBefore
        await shot("campus-permission-2-undo-window.png")
        let sentOnce = await until(10) { campus.held?.phase == .sent }
        let w1 = await log()
        report("Campus permission: Allow once waits the 3-second window, then sends {\"decision\":\"once\"} to the permission's own route, and only that",
               inWindow && early && sentOnce && w1.count == logBefore + 1 && w1.last?.hasPrefix("POST /api/spaces/private/default/conversations/\(id)/permission/\(permID)/reply") == true && w1.last?.contains("\"decision\":\"once\"") == true && w1.last?.contains("/form/") == false,
               "window=\(inWindow) early=\(early) log=\(w1.suffix(1))")

        // 5. The row stops asking, the run goes on and ends, and the transcript keeps the ask with its answer.
        let ended = await until(30) { campus.conversation(id)?.needsYou == false && campus.conversation(id)?.working == false && campus.timeline(id)?.items.last?.kind == .idle }
        report("Campus permission: after the answer the row stops asking, the run goes on, and the transcript keeps the ask with 'Answered: Allow once' where it was",
               ended && campus.openForms[id] == nil && forms().last?.status == .answered("Allow once") && forms().count == 1 && !campus.asks.contains { $0.id == id },
               "ended=\(ended) forms=\(forms().map(\.status))")
        await shot("campus-permission-3-answered.png")
        if embed {
            _ = await until(15) { box() != nil }
            await wait(0.8)
            if let page = box() {
                func dom(_ expr: String) async -> String { await page.read("JSON.stringify((function(){ \(expr) })())") }
                let text = await dom("return document.querySelector('#main').textContent;")
                report("Campus permission: the reader's page draws the finished ask quiet, with the question and 'Answered: Allow once'", text.contains("Allow bash: curl https://example.test") && text.contains("Answered: Allow once"), "text=\(text.suffix(200))")
                await shot("campus-permission-4-embed-record.png")
            } else { report("Campus permission: the reader's page draws the finished ask quiet, with the question and 'Answered: Allow once'", false, "no ready page") }
        }

        // 6. Reject: the other button, the other value; the run ends and the transcript has both records, each with its own answer.
        _ = await until(10) { campus.held == nil }
        await control("/__fake/permission?c=\(id)")
        campus.kick()
        let again = await until(20) { campus.conversation(id)?.needsYou == true && campus.openForms[id]?.isPermission == true && campus.openForms[id]?.id != permID }
        if let f = campus.openForms[id] { model.campusPick(f, in: campus.conversation(id)!, question: 0, option: "Reject") }
        _ = await until(10) { campus.held?.phase == .sent }
        let w2 = await log()
        campus.kick()
        let rejectedEnd = await until(30) { campus.conversation(id)?.needsYou == false && campus.timeline(id)?.items.last?.kind == .idle }
        report("Campus permission: Reject sends {\"decision\":\"reject\"}, the run ends, and the transcript holds both asks with their own answers",
               again && w2.last?.contains("\"decision\":\"reject\"") == true && rejectedEnd && forms().map(\.status) == [.answered("Allow once"), .answered("Reject")],
               "again=\(again) last=\(w2.last ?? "-") forms=\(forms().map(\.status))")

        // 7. Answered in Campus's own page (no event reaches Conn): the list read says nothing waits any more, the card goes, the transcript says 'Answered in Campus'.
        _ = await until(10) { campus.held == nil }
        await control("/__fake/permission?c=\(id)")
        campus.kick()
        _ = await until(20) { campus.conversation(id)?.needsYou == true && campus.timeline(id)?.openForm?.isPermission == true }
        let logBeforeElsewhere = await log().count
        await control("/__fake/permission-answered-elsewhere?c=\(id)&decision=once&announce=0")
        campus.kick()
        let closed = await until(30) { campus.conversation(id)?.needsYou == false && campus.timeline(id)?.openForm == nil }
        let sentNothing = await log().count == logBeforeElsewhere
        report("Campus permission: an ask answered in Campus's own page (no event) is closed by what Campus lists: no buttons, no row ask, 'Answered in Campus' in the transcript, and Conn sent nothing",
               closed && forms().last?.status == .resolved && campus.openForms[id] == nil && sentNothing,
               "closed=\(closed) last=\(String(describing: forms().last?.status))")
        _ = await until(30) { campus.conversation(id)?.working == false }
        model.disableCampusWrites()
        model.openCampus(id)
    }
}
