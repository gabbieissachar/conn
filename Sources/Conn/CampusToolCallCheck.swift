// `--campus-check`: a Campus tool call with something to read ("execute campus.search", Done: a `code` input, a JSON result), end to end on the stand-in. The stand-in's
// `codetool` run sends one `execute` call in opencode v2's shape (the input under `input`, the result as text parts and as a value). The steps check what Conn keeps of it
// (name, title, whole input as code, indented result, state), what the live view's card shows, and what the reader's embed page draws in its step sheet (its step row now
// says the title, `campus.search`, where it used to say the first line of the code).
import SwiftUI
import WebKit
import ConnCore

extension CampusCheck {
    static func toolCallChecks(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void, until: (Double, () -> Bool) async -> Bool,
                               control: (String) async -> Void, shot: (String) async -> Void) async {
        let campus = model.campus
        let id = "ses_fakeOffsite04"
        model.watchOn = false
        model.openCampus(id)
        _ = await until(10) { campus.timeline(id)?.loaded == true }
        // A stream that went quiet without closing (seen in this check run before this step, and only noticed by Conn after 45 s of silence) would lose the run's events and leave
        // the "while it runs" step reading nothing: start from a fresh stream.
        let reconnectsBefore = campus.reconnects
        campus.auth?.closeEventStream()
        _ = await until(15) { campus.reconnects > reconnectsBefore && campus.streamLive }
        func tool() -> CampusItem? { campus.timeline(id)?.items.last { $0.kind == .tool && $0.tool == "execute" } }
        await control("/__fake/next-run?mode=codeTool")
        await control("/__fake/run?c=\(id)&text=Find%20the%20placement%20rules&ask=0")

        // 1. While it runs: the input is there as soon as the call is made, with no result yet, and the state says running.
        // The call is read at the moment the poll sees it running (reading it again after the poll returns can be too late on a loaded machine: the stand-in's call lasts about a second).
        var early: CampusItem?
        let running = await until(20) { if tool()?.toolStatus == .running, tool()?.input.isEmpty == false { early = tool(); return true }; return false }
        await shot("campus-tool-1-running.png")
        report("Campus tool call: while it runs the card has the name, the title and the whole input as code, a running state and no result yet",
               running && early?.title == "campus.search" && early?.input.hasPrefix("const searches = [") == true && early?.input.contains("tools.campus.search") == true && early?.inputFormat == .code && early?.output.isEmpty == true,
               "status=\(String(describing: early?.toolStatus)) title='\(early?.title ?? "-")' input=\(early?.input.count ?? -1) output=\(early?.output.count ?? -1)")

        // 2. When it is done: the result as indented JSON in the order Campus's tool wrote it, the time, the state.
        let finished = await until(30) { campus.conversation(id)?.working == false && campus.timeline(id)?.items.last?.kind == .idle }
        let done = tool()
        await shot("campus-tool-2-done.png")
        report("Campus tool call: when it is done the result is there as indented JSON in its own key order, and the state is done",
               finished && done?.toolStatus == .ok && done?.outputFormat == .json && done?.output.hasPrefix("[\n  {\n    \"q\": \"placement rules for the home screen\",\n    \"hits\": [\n      {\n        \"path\": \"product/example/reference/placements\"") == true,
               "status=\(String(describing: done?.toolStatus)) format=\(String(describing: done?.outputFormat)) output=\(done?.output.prefix(80).replacingOccurrences(of: "\n", with: "\\n") ?? "-")")

        // 3. After a reload from Campus (the messages answer: the tool part with its `state`), the call is the same.
        await campus.backfill(id)
        let reloaded = tool()
        report("Campus tool call: the same call read again from Campus's messages (a part with its state) has the same title, input, result and state",
               reloaded?.title == "campus.search" && reloaded?.input.hasPrefix("const searches = [") == true && reloaded?.inputFormat == .code && reloaded?.toolStatus == .ok && reloaded?.output.contains("\"snippet\": \"Example placements: what a user meets first\"") == true && reloaded?.detail == "1.2s",
               "title='\(reloaded?.title ?? "-")' status=\(String(describing: reloaded?.toolStatus)) detail='\(reloaded?.detail ?? "-")' output=\(reloaded?.output.count ?? -1)")

        // 4. The reader's embed page (with a copy of its file): the step's sheet shows the code and the result.
        guard let url = model.web.embedURL, url.isFileURL else {
            print("ui-check: SKIP Campus tool call on the embed page (no CONN_EMBED_URL file)")
            return
        }
        model.openCampus(id)
        func box() -> CampusEmbedBox? { CampusEmbedBox.live.allObjects.first { $0.column == nil && $0.shownID == id && $0.phase == .ready && $0.sets > 0 } }
        _ = await until(20) { box() != nil }
        await wait(0.8)
        guard let page = box() else { report("Campus tool call: the embed page shows the call's code and its result in the step sheet", false, "no ready page"); return }
        func dom(_ expr: String) async -> String { await page.read("JSON.stringify((function(){ \(expr) })())") }
        _ = await dom("var r = document.querySelectorAll('#main .reply'); var last = r[r.length - 1]; last.querySelector('.steps-row').click(); return 1;")
        await wait(0.3)
        _ = await dom("var s = [].filter.call(document.querySelectorAll('#main .step'), function (n) { return n.textContent.indexOf('const searches') >= 0 || n.textContent.indexOf('campus.search') >= 0; })[0]; if (s) s.click(); return s ? 1 : 0;")
        await wait(0.4)
        let sheet = await dom("var d = document.querySelector('.step-sheet'); if (!d || d.hidden) return null; return { title: d.querySelector('.step-title').textContent, code: [].map.call(d.querySelectorAll('.step-code'), function (n) { return n.textContent; }), labels: [].map.call(d.querySelectorAll('.step-sec h3, .step-sec .lab, .step-sec label'), function (n) { return n.textContent; }) };")
        let parsed = (try? JSONSerialization.jsonObject(with: Data(sheet.utf8))) as? [String: Any]
        let code = parsed?["code"] as? [String] ?? []
        report("Campus tool call: on the reader's embed page the step's sheet holds the code that was run and the result (what the page keeps of it today)",
               code.first?.hasPrefix("const searches = [") == true && code.first?.contains("tools.campus.search") == true && code.count >= 2 && code.last?.contains("\"hits\"") == true,
               "sheet=\(sheet.prefix(400))")
        await shot("campus-tool-3-embed-sheet.png")
        _ = await dom("var c = document.querySelector('.step-sheet [data-act=\"close\"]'); if (c) c.click(); return 1;")
    }
}
