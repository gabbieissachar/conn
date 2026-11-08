// `--ui-check` steps for a click on a file in the reader's page (README "Opening a file from the reader"). The fixture's reader page and lite page each draw the two
// elements the real reader draws: a link in a reply (`a.file-ref[data-path]`) and a button in the Documents view (`button.file-ref[data-path]`). A click is dispatched in
// the page like a real one, so the whole route runs: the injected script, the message handler, the path check and the Editor view. Fixture launches only: the real
// reader's pages are never clicked here, and nothing is written but two small files in a temporary folder.
import SwiftUI
import WebKit
import ConnCore

@MainActor
enum FileRefCheck {
    static func run(model: AppModel, report: (String, Bool, String) -> Void, wait: (Double) async -> Void) async {
        guard model.config.fixture else { print("ui-check: SKIP file links from the reader (the fixture pages carry the elements; run with --fixture)"); return }
        let saved = (mode: model.mode, web: model.showWeb, tab: model.webTab, watch: model.watchOn)
        defer { model.watchOn = saved.watch; model.mode = saved.mode; model.showWeb = saved.web; model.webTab = saved.tab }
        func js(_ box: WebBox, _ s: String) async -> String { await ReaderPinCheck.js(box, s) }

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("conn-ui-check-fileref-\(UUID().uuidString)", isDirectory: true)
        let folder = dir.appendingPathComponent("a folder", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let notes = dir.appendingPathComponent("notes with spaces.md"), plan = dir.appendingPathComponent("plan.md")
        try? "# Notes\n\nA reader link opens here.\n".write(to: notes, atomically: true, encoding: .utf8)
        try? "# Plan\n\nA Documents button opens here.\n".write(to: plan, atomically: true, encoding: .utf8)
        func sameFile(_ a: URL?, _ b: URL) -> Bool { a?.resolvingSymlinksInPath().path == b.resolvingSymlinksInPath().path }
        func closeAll() { for d in model.editor.docs { _ = model.editor.close(d) } }
        func jsString(_ s: String) -> String { "'" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'") + "'" }
        /// Point an element at a path and click it the way a person does (a real click event, cancelable, bubbling): "prevented" when the page's own handling was cancelled.
        func click(_ b: WebBox, _ which: String, path: String?, type: String = "click", button: Int = 0) async -> String {
            let set = path.map { "el.setAttribute('data-path', \(jsString($0)));" } ?? ""
            return await js(b, "(() => { const el = document.querySelector('[data-ref-file=\"\(which)\"]'); if (!el) return 'no element'; \(set) return el.dispatchEvent(new MouseEvent('\(type)', { bubbles: true, cancelable: true, view: window, button: \(button) })) ? 'not prevented' : 'prevented'; })()")
        }
        func reset() { closeAll(); model.mode = .agent; model.toastText = nil; model.toastDetail = nil }

        // The full Reader column.
        model.watchOn = false
        model.mode = .agent; model.showWeb = true; model.webTab = .reader; model.pinReader(); await wait(0.5)
        let reader = model.web.box(.reader)
        await ReaderPinCheck.settled(reader, wait: wait)
        await wait(0.3)
        let injected = await js(reader, "String(window.__connFileRefs)")
        let hashBefore = await js(reader, "location.hash")
        let drawn = await js(reader, "String(document.querySelectorAll('.file-ref[data-path]').length)")
        report("the Reader column's page carries a file link and a Documents button (.file-ref[data-path]) and Conn's click handler is in it",
               injected == "true" && reader.phase == .ready && drawn == "2", "handler=\(injected) phase=\(reader.phase) elements=\(drawn)")
        reset()
        let r1 = await click(reader, "link", path: notes.path); await wait(0.6)
        let hashAfter = await js(reader, "location.hash")
        report("a click on a file link in the Reader column opens it in the Editor view of this window, and the page does not follow the link",
               r1 == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, notes) && model.editor.docs.count == 1 && hashAfter == hashBefore,
               "click=\(r1) mode=\(model.mode.rawValue) open=\(model.editor.current?.url?.lastPathComponent ?? "-") tabs=\(model.editor.docs.count) hash=\(hashAfter)")
        reset()
        let r2 = await click(reader, "button", path: plan.path); await wait(0.6)
        report("a click on the Documents view's file button opens it the same way", r2 == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, plan), "click=\(r2) mode=\(model.mode.rawValue) open=\(model.editor.current?.url?.lastPathComponent ?? "-")")
        reset()
        let r3 = await click(reader, "link", path: notes.path, type: "auxclick", button: 1); await wait(0.6)
        report("a middle click opens it too, and the page does not navigate", r3 == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, notes), "click=\(r3) mode=\(model.mode.rawValue)")
        reset()
        let inner = await js(reader, "(() => { const el = document.querySelector('[data-ref-file=\"link\"]'); el.setAttribute('data-path', \(jsString(plan.path))); el.innerHTML = '<b id=\"inner\">plan</b>'; return document.getElementById('inner').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })) ? 'not prevented' : 'prevented'; })()")
        await wait(0.6)
        report("a click on something inside the link counts as a click on the link", inner == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, plan), "click=\(inner) open=\(model.editor.current?.url?.lastPathComponent ?? "-")")

        // Refusals: a notice, nothing opened, the view stays where it was.
        for (label, p, want) in [("a missing file", dir.appendingPathComponent("gone.md").path, "It does not exist"), ("a folder", folder.path, "It is a folder, not a file"),
                                 ("a path that is not absolute", "docs/notes.md", "The page gave a path that is not absolute"), ("an empty path", "", "The page gave no usable path")] {
            reset()
            let r = await click(reader, "button", path: p); await wait(0.4)
            report("\(label) opens nothing, the view stays on the Agent view, and a notice says why",
                   r == "prevented" && model.mode == .agent && model.editor.docs.isEmpty && model.toastText?.hasPrefix("Conn did not open") == true && model.toastDetail == want,
                   "click=\(r) mode=\(model.mode.rawValue) tabs=\(model.editor.docs.count) toast=\(model.toastText ?? "nil") / \(model.toastDetail ?? "nil")")
        }
        reset()

        // The Organizer is not a reader page: no handler, so its own links are untouched.
        let organizer = model.web.box(.organizer)
        report("the Organizer page has no file-click handler", (organizer.webView.configuration.userContentController.userScripts.allSatisfy { !$0.source.contains("__connFileRefs") }), "scripts=\(organizer.webView.configuration.userContentController.userScripts.count)")

        // A Watch column (the lite page).
        model.mode = .agent; model.showWeb = true; model.webTab = .reader
        model.watchOn = true
        /// The first column's page, once every column's page is loaded (leaving the Agent view turns Watch off and lets the columns go, so each click starts with Watch on again).
        func firstColumn() async -> WebBox? {
            var t = 0.0
            while t < 20, !(model.watch.boxes.count >= 1 && model.watch.boxes.values.allSatisfy { $0.phase == .ready && !$0.released }) { await wait(0.25); t += 0.25 }
            await wait(0.6)
            return model.watch.layout.slots.compactMap({ $0 }).compactMap({ model.watch.boxes[$0.id] }).first
        }
        guard var column = await firstColumn() else { report("a Watch column is there to click in", false, "boxes=\(model.watch.boxes.count)"); return }
        let wInjected = await js(column, "String(window.__connFileRefs)")
        let wHash = await js(column, "location.hash")
        report("a Watch column's page has the same handler", wInjected == "true" && column.lite, "handler=\(wInjected)")
        closeAll(); model.toastText = nil; model.toastDetail = nil      // not `reset()`: choosing the Agent view again would end the Watch that is on
        let w1 = await click(column, "link", path: notes.path); await wait(0.6)
        let wHashAfter = await js(column, "location.hash")
        report("a click on a file link in a Watch column opens it in the Editor view and the column does not navigate",
               w1 == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, notes) && wHashAfter == wHash,
               "click=\(w1) mode=\(model.mode.rawValue) open=\(model.editor.current?.url?.lastPathComponent ?? "-")")
        reset(); model.watchOn = true; column = await firstColumn() ?? column
        let w2 = await click(column, "button", path: plan.path); await wait(0.6)
        report("... and so does the Documents button in a column; the Editor view takes the window, so Watch is off, as for any other change of view", w2 == "prevented" && model.mode == .editor && sameFile(model.editor.current?.url, plan) && !model.watchOn, "click=\(w2) mode=\(model.mode.rawValue) watchOn=\(model.watchOn)")
        reset(); model.watchOn = true; column = await firstColumn() ?? column
        let w3 = await click(column, "link", path: dir.appendingPathComponent("gone.md").path); await wait(0.4)
        report("... a missing file in a column opens nothing, says so, and Watch stays on", w3 == "prevented" && model.mode == .agent && model.watchOn && model.editor.docs.isEmpty && model.toastDetail == "It does not exist", "click=\(w3) toast=\(model.toastText ?? "nil") / \(model.toastDetail ?? "nil")")
        reset()
    }
}
